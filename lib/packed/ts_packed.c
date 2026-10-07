// Packed tree-sitter language tables: codec and loader. See ts_packed.h.
//
// The blob is a single adaptive binary range-coded stream. One model function
// per table runs unchanged in both directions: while encoding it reads the
// value it is about to code from the intermediate representation (`IR`) the
// packer extracted from a real `TSLanguage`; while decoding it writes the
// decoded value into the same place. Every prediction a model makes reads
// only data that was coded before it, so the two directions stay in lockstep.
//
// The parse table is not coded cell by cell. tree-sitter's LR(1) states are
// copies of a much smaller set of LR(0) "cores" (the classes
// `primary_state_ids` already describes), with states numbered in the
// canonical breadth-first order arborium-rt's tree-sitter patch emits. The
// model codes, per state:
//   - its structure (shift/goto symbols, reduce actions, extras), predicted
//     from the previous state with the same core or, for a core's first state,
//     from the most similar earlier core;
//   - each shift/goto target, predicted from earlier states of the same core
//     that agreed on the targets coded so far, then from any earlier state
//     that agreed, and otherwise as "the next new state" or a member of the
//     target's core;
//   - the lookahead set of each reduce action, mostly as a reference to an
//     earlier set;
//   - its lex mode, which tree-sitter derives from the valid-token set.
// Action list ids, the grouped small_parse_table rows, small_parse_table_map,
// primary_state_ids and every action's `reusable` flag are then re-derived
// exactly as `tree-sitter generate` derives them.

#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#ifdef TS_PACKED_GRAMMAR_HEADER
#include "tree_sitter/parser.h"
#else
#include "parser.h"
#endif

#include "ts_packed.h"

#define TS_PACKED_MAGIC 0x31505354u  // "TSP1"
#define NONE UINT32_MAX

// ---------------------------------------------------------------------------
// Codec state, vectors, hashing

typedef struct {
  uint16_t p;  // probability of a 0 bit, in 1/65536
  uint8_t n;   // number of updates, saturating; drives the adaptation rate
} Bit;

typedef struct {
  uint64_t *keys;
  uint32_t *vals;
  uint32_t cap;
  uint32_t len;
} Map;

#define VEC(T) struct { T *data; uint32_t len, cap; }

typedef VEC(uint8_t) U8Vec;
typedef VEC(uint16_t) U16Vec;
typedef VEC(uint32_t) U32Vec;

typedef struct {
  uint32_t vals[8];
  uint32_t counts[8];
  uint8_t len;
} Cands;

typedef VEC(Cands) CandsVec;

typedef struct Codec {
  bool enc;
  bool failed;

  // range coder
  uint64_t low;
  uint32_t range;
  uint32_t code;
  uint8_t cache;
  uint64_t cache_size;
  U8Vec out;
  const uint8_t *in;
  size_t in_len;
  size_t in_pos;

  // adaptive contexts: small fixed ones by (component, index), others hashed
  Bit fixed[96][64];
  Map bit_index;
  VEC(Bit) bits;
} Codec;

#define MARK_FAILED(c) ((c)->failed = true)

static bool vec_grow(Codec *c, void **data, uint32_t *cap, uint32_t need, size_t elem) {
  if (c->failed) return false;
  uint32_t new_cap = *cap ? *cap : 16;
  while (new_cap < need) new_cap *= 2;
  void *p = realloc(*data, (size_t)new_cap * elem);
  if (!p) {
    MARK_FAILED(c);
    return false;
  }
  memset((char *)p + (size_t)*cap * elem, 0, (size_t)(new_cap - *cap) * elem);
  *data = p;
  *cap = new_cap;
  return true;
}

static inline bool vec_reserve(Codec *c, void **data, uint32_t *cap, uint32_t need, size_t elem) {
  return need <= *cap || vec_grow(c, data, cap, need, elem);
}

#define VRESERVE(c, v, n) vec_reserve((c), (void **)&(v).data, &(v).cap, (n), sizeof(*(v).data))
#define VPUSH(c, v, x)                                                          \
  (((v).len < (v).cap || VRESERVE((c), (v), (v).len + 1)) ? ((v).data[(v).len++] = (x), true) \
                                                          : false)
#define VFREE(v) (free((v).data), (v).data = NULL, (v).len = (v).cap = 0)

static inline uint64_t mix64(uint64_t x) {
  x ^= x >> 30;
  x *= 0xbf58476d1ce4e5b9ull;
  x ^= x >> 27;
  x *= 0x94d049bb133111ebull;
  x ^= x >> 31;
  return x;
}

static inline uint64_t kx(uint64_t key, uint64_t a) {
  return mix64(key ^ mix64(a + 0x9e3779b97f4a7c15ull));
}

#ifdef TS_PACKED_STATS
#include <math.h>
static uint32_t g_comp;
double g_stat_bits[256];
uint64_t g_stat_count[256];
#endif

// Context keys: a component tag plus up to two small fields.
static inline uint64_t K(uint32_t comp, uint64_t a, uint64_t b) {
#ifdef TS_PACKED_STATS
  g_comp = comp & 0xFF;
#endif
  return mix64(((uint64_t)comp << 56) ^ (a << 28) ^ b);
}

// Returns a pointer to the value slot for `key`, inserting UINT32_MAX if new.
static uint32_t *map_slot(Codec *c, Map *m, uint64_t key) {
  if ((m->len + 1) * 2 > m->cap) {
    uint32_t new_cap = m->cap ? m->cap * 2 : 1024;
    uint64_t *keys = calloc(new_cap, sizeof(uint64_t));
    uint32_t *vals = malloc(new_cap * sizeof(uint32_t));
    if (!keys || !vals) {
      free(keys);
      free(vals);
      MARK_FAILED(c);
      static uint32_t dummy;
      dummy = UINT32_MAX;
      return &dummy;
    }
    memset(vals, 0xff, new_cap * sizeof(uint32_t));
    for (uint32_t i = 0; i < m->cap; i++) {
      if (m->vals[i] == UINT32_MAX) continue;
      uint32_t j = (uint32_t)mix64(m->keys[i]) & (new_cap - 1);
      while (vals[j] != UINT32_MAX) j = (j + 1) & (new_cap - 1);
      keys[j] = m->keys[i];
      vals[j] = m->vals[i];
    }
    free(m->keys);
    free(m->vals);
    m->keys = keys;
    m->vals = vals;
    m->cap = new_cap;
  }
  uint32_t j = (uint32_t)mix64(key) & (m->cap - 1);
  while (m->vals[j] != UINT32_MAX) {
    if (m->keys[j] == key) return &m->vals[j];
    j = (j + 1) & (m->cap - 1);
  }
  m->keys[j] = key;
  m->len++;
  return &m->vals[j];
}

static uint32_t map_get(const Map *m, uint64_t key) {
  if (!m->cap) return UINT32_MAX;
  uint32_t j = (uint32_t)mix64(key) & (m->cap - 1);
  while (m->vals[j] != UINT32_MAX) {
    if (m->keys[j] == key) return m->vals[j];
    j = (j + 1) & (m->cap - 1);
  }
  return UINT32_MAX;
}

static void map_free(Map *m) {
  free(m->keys);
  free(m->vals);
  memset(m, 0, sizeof(*m));
}

static inline uint32_t bit_length(uint32_t x) {
  uint32_t n = 0;
  while (x) {
    n++;
    x >>= 1;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Range coder (LZMA-style, carry-propagating) with count-adaptive bit models

static void rc_out(Codec *c, uint8_t byte) {
  VPUSH(c, c->out, byte);
}

static void rc_shift_low(Codec *c) {
  if ((uint32_t)c->low < 0xFF000000u || (c->low >> 32) != 0) {
    uint8_t carry = (uint8_t)(c->low >> 32);
    uint8_t temp = c->cache;
    do {
      rc_out(c, (uint8_t)(temp + carry));
      temp = 0xFF;
    } while (--c->cache_size != 0);
    c->cache = (uint8_t)(c->low >> 24);
  }
  c->cache_size++;
  c->low = (c->low & 0x00FFFFFFu) << 8;
}

static uint8_t rc_in(Codec *c) {
  if (c->in_pos < c->in_len) return c->in[c->in_pos++];
  // Running past the end by more than the flush slack means a corrupt blob.
  if (++c->in_pos > c->in_len + 8) MARK_FAILED(c);
  return 0;
}

static void rc_init(Codec *c) {
  c->low = 0;
  c->range = 0xFFFFFFFFu;
  c->cache = 0;
  c->cache_size = 1;
  c->code = 0;
  if (!c->enc) {
    for (int i = 0; i < 5; i++) c->code = (c->code << 8) | rc_in(c);
  }
}

static const uint16_t RATE[32] = {
  32768, 21845, 16384, 13107, 10923, 9362, 8192, 7282, 6554, 5958, 5461,
  5041,  4681,  4369,  4096,  3855,  3641, 3449, 3277, 3121, 2979, 2849,
  2731,  2621,  2521,  2427,  2341,  2260, 2185, 2114, 2048, 2048,
};

static inline int code_bit_with(Codec *c, Bit *b, int bit) {
#ifdef TS_PACKED_STATS
  if (c->enc) {
    g_stat_bits[g_comp] += -log2((bit ? 65536.0 - b->p : (double)b->p) / 65536.0);
    g_stat_count[g_comp]++;
  }
#endif
  uint32_t bound = (c->range >> 16) * b->p;
  if (c->enc) {
    if (!bit) {
      c->range = bound;
    } else {
      c->low += bound;
      c->range -= bound;
    }
    while (c->range < (1u << 24)) {
      c->range <<= 8;
      rc_shift_low(c);
    }
  } else {
    if (c->code < bound) {
      c->range = bound;
      bit = 0;
    } else {
      c->code -= bound;
      c->range -= bound;
      bit = 1;
    }
    while (c->range < (1u << 24)) {
      c->range <<= 8;
      c->code = (c->code << 8) | rc_in(c);
    }
  }
  uint32_t p = b->p;
  if (bit) {
    p -= (p * RATE[b->n]) >> 16;
    if (p < 32) p = 32;
  } else {
    p += ((65535 - p) * RATE[b->n]) >> 16;
    if (p > 65503) p = 65503;
  }
  b->p = (uint16_t)p;
  if (b->n < 30) b->n++;
  return bit;
}

static void codec_init_fixed(Codec *c) {
  for (int i = 0; i < 96; i++) {
    for (int j = 0; j < 64; j++) c->fixed[i][j] = (Bit){32768, 0};
  }
}

// Code one bit in the small fixed context (comp, idx), idx < 64.
static inline int cbitf(Codec *c, uint32_t comp, uint32_t idx, int bit) {
#ifdef TS_PACKED_STATS
  g_comp = comp;
#endif
  return code_bit_with(c, &c->fixed[comp][idx & 63], bit ? 1 : 0);
}

// Code one bit in the adaptive context `key`. Encoding codes `bit`; decoding
// ignores it. Returns the coded bit.
static int cbit(Codec *c, uint64_t key, int bit) {
  uint32_t *slot = map_slot(c, &c->bit_index, key);
  if (*slot == UINT32_MAX) {
    if (!VPUSH(c, c->bits, ((Bit){32768, 0}))) {
      *slot = UINT32_MAX;
      static Bit dummy;
      dummy = (Bit){32768, 0};
      return code_bit_with(c, &dummy, bit);
    }
    *slot = c->bits.len - 1;
  }
  return code_bit_with(c, &c->bits.data[*slot], bit ? 1 : 0);
}

// Adaptive Elias-gamma code for any 32-bit value.
static uint32_t cnum(Codec *c, uint64_t key, uint32_t v) {
  uint64_t x = (uint64_t)v + 1;
  uint32_t nb = 0;
  if (c->enc) {
    uint64_t t = x;
    while (t) {
      nb++;
      t >>= 1;
    }
  }
  uint32_t n = 1;
  while (n < 33) {
    int more = cbit(c, kx(key, n), c->enc && nb > n);
    if (!more) break;
    n++;
  }
  uint64_t val = 1;
  for (int i = (int)n - 2; i >= 0; i--) {
    int depth = (int)n - 2 - i;
    uint64_t ctx = depth < 3 ? ((uint64_t)n << 40) | val : ((uint64_t)n << 40) | (1ull << 39) | (uint64_t)i;
    int b = cbit(c, kx(key ^ 0x5555, ctx), c->enc ? (int)((x >> i) & 1) : 0);
    val = (val << 1) | (uint64_t)b;
  }
  return (uint32_t)(val - 1);
}

// Code `v` in [0, n) with a bit tree over ceil(log2(n)) bits, skipping bits
// whose value is forced by the bound.
static uint32_t cbelow(Codec *c, uint64_t key, uint32_t v, uint32_t n) {
  if (n <= 1) return 0;
  uint32_t nbits = bit_length(n - 1);
  uint32_t val = 0;
  for (int i = (int)nbits - 1; i >= 0; i--) {
    uint32_t with_one = val | (1u << i);
    if (with_one >= n) continue;
    uint64_t node = ((uint64_t)nbits << 40) | ((uint64_t)(uint32_t)i << 32) | (val >> i);
    int b = cbit(c, kx(key, node), c->enc ? (int)((v >> i) & 1) : 0);
    if (b) val = with_one;
  }
  return val;
}

// Code whether `v` is one of the candidates in `cl` and which. Returns the
// candidate index, or -1 when the value was not a candidate (the caller then
// codes it some other way and calls cands_update with -1).
static int cands_code(Codec *c, const Cands *cl, uint32_t comp, uint32_t v) {
  for (int i = 0; i < cl->len; i++) {
    int hit = cbitf(c, comp, (uint32_t)(i * 8 + cl->len - 1), c->enc && cl->vals[i] == v);
    if (hit) return i;
  }
  return -1;
}

static void cands_update(Cands *cl, int i, uint32_t v) {
  if (i < 0) {
    if (cl->len < 8) {
      i = cl->len++;
    } else {
      i = 7;
    }
    cl->vals[i] = v;
    cl->counts[i] = 0;
  }
  cl->counts[i]++;
  while (i > 0 && cl->counts[i] >= cl->counts[i - 1]) {
    uint32_t tv = cl->vals[i], tc = cl->counts[i];
    cl->vals[i] = cl->vals[i - 1];
    cl->counts[i] = cl->counts[i - 1];
    cl->vals[i - 1] = tv;
    cl->counts[i - 1] = tc;
    i--;
  }
}

// ---------------------------------------------------------------------------
// Symbol set pool: interned sorted lists of symbols.

typedef struct {
  U16Vec items;
  U32Vec offs;
  U32Vec lens;
  Map index;  // content hash -> first id with that hash; collisions chain via `next`
  U32Vec next;
} SetPool;

static uint64_t set_hash(const uint16_t *s, uint32_t n) {
  uint64_t h = 0x84222325cbf29ce4ull ^ n;
  for (uint32_t i = 0; i < n; i++) h = mix64(h ^ s[i]);
  return h;
}

static uint32_t pool_find(const SetPool *p, const uint16_t *s, uint32_t n) {
  uint32_t id = map_get(&p->index, set_hash(s, n));
  while (id != UINT32_MAX) {
    if (p->lens.data[id] == n && !memcmp(p->items.data + p->offs.data[id], s, n * sizeof(uint16_t))) {
      return id;
    }
    id = p->next.data[id];
  }
  return NONE;
}

static uint32_t pool_intern(Codec *c, SetPool *p, const uint16_t *s, uint32_t n) {
  uint32_t found = pool_find(p, s, n);
  if (found != NONE) return found;
  uint32_t id = p->offs.len;
  uint32_t off = p->items.len;
  if (!VRESERVE(c, p->items, off + n)) return 0;
  if (n) memcpy(p->items.data + off, s, n * sizeof(uint16_t));
  p->items.len = off + n;
  uint32_t *slot = map_slot(c, &p->index, set_hash(s, n));
  if (!VPUSH(c, p->offs, off) || !VPUSH(c, p->lens, n) || !VPUSH(c, p->next, *slot)) return 0;
  *slot = id;
  return id;
}

static inline const uint16_t *pool_items(const SetPool *p, uint32_t id) {
  return p->items.data + p->offs.data[id];
}

static void pool_free(SetPool *p) {
  VFREE(p->items);
  VFREE(p->offs);
  VFREE(p->lens);
  VFREE(p->next);
  map_free(&p->index);
}

static bool sorted_contains(const uint16_t *s, uint32_t n, uint16_t x) {
  uint32_t lo = 0, hi = n;
  while (lo < hi) {
    uint32_t mid = (lo + hi) / 2;
    if (s[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo < n && s[lo] == x;
}

// ---------------------------------------------------------------------------
// Intermediate representation

typedef struct {
  uint16_t sym;
  uint16_t target;
  uint8_t rep;
} Trans;

typedef struct {
  uint16_t red;  // reduce action id
  uint32_t la;   // lookahead set id in `la_pool`
} Red;

typedef struct {
  uint16_t sym;
  uint8_t n;
  uint8_t perm[8];  // perm[i]: canonical index of the i-th action as stored
} OrderExc;

typedef struct {
  uint16_t symbol;
  uint8_t child_count;
  int16_t dynamic_precedence;
  uint16_t production_id;
} RedAct;

typedef struct {
  uint32_t core;
  uint32_t trans_off, trans_n;
  uint32_t red_off, red_n;
  uint32_t selfg, extras, acc, rec;  // ids in `misc_pool`
  uint32_t reus_exc;  // misc pool: terminals whose `reusable` flag the overlap relation mispredicts
  uint32_t ord_off, ord_n;
  uint16_t lex_state, ext_lex_state, reserved_id;
} PState;

typedef struct {
  // header
  uint32_t abi_version, symbol_count, alias_count, token_count, external_token_count;
  uint32_t state_count, production_id_count, field_count, max_alias_sequence_length;
  uint32_t keyword_capture_token, max_reserved_word_set_size, supertype_count;
  uint8_t metadata[3];
  bool has_keyword_lex, has_external_scanner;
  bool has_field_map, has_alias_sequences, has_alias_map, has_name;

  // misc tables, flattened
  U8Vec strings;          // NUL-terminated names, in order: symbols, fields (1..), name
  U8Vec symbol_metadata;  // 3 bytes per symbol (visible, named, supertype)
  U16Vec public_symbol_map;
  U16Vec alias_map;       // including the terminating 0
  U16Vec alias_sequences;
  U16Vec field_map_slices;  // (index, length) pairs
  U8Vec field_map_entries;  // 4 bytes per entry (field_id u16, child_index, inherited)
  U16Vec external_symbol_map;
  U8Vec external_states;    // bools, ext_state_count * external_token_count
  uint32_t ext_state_count;
  U16Vec reserved_words;    // reserved_set_count * max_reserved_word_set_size
  uint32_t reserved_set_count;
  U16Vec supertype_symbols;
  U16Vec supertype_map_slices;  // pairs, supertype_slice_count of them
  uint32_t supertype_slice_count;
  U16Vec supertype_map_entries;

  // parse table
  VEC(RedAct) red_acts;
  U16Vec rank_order;  // symbols in group sort order
  U16Vec overlap;     // per token: count, then that many tokens
  VEC(PState) states;
  VEC(Trans) trans;
  VEC(Red) reds;
  VEC(OrderExc) ords;
  SetPool la_pool;      // lookahead sets, interned in coding order
  SetPool misc_pool;    // extras/accept/recover/self-goto sets; id 0 is empty
  SetPool src_la_pool;  // encoder: lookahead sets as extracted (Red.la ids)
  const uint16_t *enc_primary;  // encoder: the language's primary_state_ids
} IR;

static void ir_free(IR *ir) {
  VFREE(ir->strings);
  VFREE(ir->symbol_metadata);
  VFREE(ir->public_symbol_map);
  VFREE(ir->alias_map);
  VFREE(ir->alias_sequences);
  VFREE(ir->field_map_slices);
  VFREE(ir->field_map_entries);
  VFREE(ir->external_symbol_map);
  VFREE(ir->external_states);
  VFREE(ir->reserved_words);
  VFREE(ir->supertype_symbols);
  VFREE(ir->supertype_map_slices);
  VFREE(ir->supertype_map_entries);
  VFREE(ir->red_acts);
  VFREE(ir->rank_order);
  VFREE(ir->overlap);
  VFREE(ir->states);
  VFREE(ir->trans);
  VFREE(ir->reds);
  VFREE(ir->ords);
  pool_free(&ir->la_pool);
  pool_free(&ir->misc_pool);
  pool_free(&ir->src_la_pool);
}

// Context component tags.
enum {
  C_HDR = 1,
  C_STR_DUP, C_STR_DUPIDX, C_STR_BYTE,
  C_META, C_PSM, C_PSM_VAL, C_AMAP, C_ASEQ_NZ, C_ASEQ_VAL,
  C_FSLICE, C_FENTRY, C_EXT_SYM, C_EXT_STATE, C_RESERVED, C_SUPER,
  C_RED_SYM, C_RED_CC, C_RED_DP, C_RED_PID,
  C_RANK_NEXT, C_RANK_SYM, C_OVL_N, C_OVL_TOK,
  C_ROOT_NEW, C_ROOT_CORE,
  C_SAME, C_SET_SAME, C_SET_BIT, C_HASREF, C_REFIDX, C_TRANS_BIT,
  C_REP, C_RED_IN, C_RED_EXTRA_N, C_RED_EXTRA,
  C_P_HIT, C_ISNEW, C_NEWCORE, C_SKEL_OK, C_CORE_CAND, C_CORE_LIST, C_CORE_RAW,
  C_MEM_LIST, C_MEM_RAW,
  C_LA_RED, C_LA_GLOB, C_LA_GIDX, C_LA_REF, C_LA_BIT,
  C_LM_HIT, C_LM_LEX, C_LM_EXT, C_LM_RES,
  C_ORD, C_ORD_P, C_REUS_ANY, C_REUS_BIT,
};

// ---------------------------------------------------------------------------
// Models for the small tables

#define ENC (c->enc)

static uint32_t chdr(Codec *c, uint32_t field, uint32_t v) {
  return cnum(c, K(C_HDR, field, 0), v);
}

static void code_strings(Codec *c, IR *ir, uint32_t count) {
  // Each string is either a repeat of an earlier one (aliases share names)
  // or coded byte by byte with an order-1 context.
  U32Vec starts = {0};
  uint32_t pos = 0;
  for (uint32_t i = 0; i < count && !c->failed; i++) {
    uint32_t start = ENC ? pos : ir->strings.len;
    uint32_t dup = NONE;
    if (ENC) {
      const char *s = (const char *)ir->strings.data + start;
      for (uint32_t j = 0; j < starts.len; j++) {
        if (!strcmp((const char *)ir->strings.data + starts.data[j], s)) {
          dup = j;
          break;
        }
      }
    }
    int is_dup = cbit(c, K(C_STR_DUP, 0, 0), dup != NONE);
    if (is_dup) {
      dup = cbelow(c, K(C_STR_DUPIDX, 0, 0), dup, starts.len);
      const char *s = (const char *)ir->strings.data + starts.data[dup];
      uint32_t len = (uint32_t)strlen(s) + 1;
      if (ENC) {
        pos += len;
      } else {
        if (!VRESERVE(c, ir->strings, ir->strings.len + len)) break;
        memmove(ir->strings.data + ir->strings.len, ir->strings.data + starts.data[dup], len);
        ir->strings.len += len;
      }
    } else {
      uint32_t prev = 0;
      for (;;) {
        uint32_t byte = ENC ? ir->strings.data[pos++] : 0;
        uint32_t node = 1;
        for (int b = 7; b >= 0; b--) {
          int bit = cbit(c, K(C_STR_BYTE, prev, node), (byte >> b) & 1);
          node = (node << 1) | (uint32_t)bit;
        }
        byte = node & 0xFF;
        if (!ENC && !VPUSH(c, ir->strings, (uint8_t)byte)) break;
        if (!byte) break;
        prev = byte;
        if (c->failed) break;
      }
    }
    VPUSH(c, starts, start);
  }
  VFREE(starts);
}

static void code_u16s(Codec *c, uint32_t comp, U16Vec *v, uint32_t count) {
  if (!ENC && !VRESERVE(c, *v, count)) return;
  uint32_t prev = 0;
  for (uint32_t i = 0; i < count && !c->failed; i++) {
    uint32_t x = ENC ? v->data[i] : 0;
    x = cnum(c, K(comp, prev == 0 ? 0 : 1, 0), x);
    if (!ENC) v->data[v->len++] = (uint16_t)x;
    prev = x;
  }
}

static void code_misc_tables(Codec *c, IR *ir) {
  uint32_t nsym = ir->symbol_count + ir->alias_count;

  // Names: symbols, then fields, then the language name.
  code_strings(c, ir, nsym + ir->field_count + (ir->has_name ? 1 : 0));

  // Symbol metadata: three flags each, conditioned on the previous symbol's.
  if (!ENC && !VRESERVE(c, ir->symbol_metadata, nsym * 3)) return;
  uint32_t prev = 0;
  for (uint32_t i = 0; i < nsym * 3; i++) {
    uint32_t f = i % 3;
    int b = cbit(c, K(C_META, f, (prev << 1) | (i / 3 < ir->token_count)), ENC && ir->symbol_metadata.data[i]);
    if (!ENC) ir->symbol_metadata.data[ir->symbol_metadata.len++] = (uint8_t)b;
    prev = f == 2 ? 0 : (prev << 1) | (uint32_t)b;
  }

  // Public symbol map: mostly the identity.
  if (!ENC && !VRESERVE(c, ir->public_symbol_map, nsym)) return;
  for (uint32_t i = 0; i < nsym && !c->failed; i++) {
    uint32_t v = ENC ? ir->public_symbol_map.data[i] : i;
    int same = cbit(c, K(C_PSM, 0, 0), v == i);
    if (!same) v = cbelow(c, K(C_PSM_VAL, 0, 0), v, nsym);
    if (!ENC) ir->public_symbol_map.data[ir->public_symbol_map.len++] = (uint16_t)v;
  }

  if (ir->has_alias_map) {
    uint32_t n = chdr(c, 100, ir->alias_map.len);
    code_u16s(c, C_AMAP, &ir->alias_map, n);
  }

  if (ir->has_alias_sequences) {
    uint32_t n = ir->production_id_count * ir->max_alias_sequence_length;
    if (!ENC && !VRESERVE(c, ir->alias_sequences, n)) return;
    for (uint32_t i = 0; i < n && !c->failed; i++) {
      uint32_t v = ENC ? ir->alias_sequences.data[i] : 0;
      int nz = cbit(c, K(C_ASEQ_NZ, i % ir->max_alias_sequence_length, 0), v != 0);
      if (nz) v = cbelow(c, K(C_ASEQ_VAL, 0, 0), v, nsym);
      if (!ENC) ir->alias_sequences.data[ir->alias_sequences.len++] = (uint16_t)v;
    }
  }

  if (ir->has_field_map) {
    code_u16s(c, C_FSLICE, &ir->field_map_slices, ir->production_id_count * 2);
    uint32_t n = chdr(c, 101, ir->field_map_entries.len / 4);
    if (!ENC && !VRESERVE(c, ir->field_map_entries, n * 4)) return;
    for (uint32_t i = 0; i < n && !c->failed; i++) {
      uint8_t *e = ENC ? ir->field_map_entries.data + i * 4 : NULL;
      uint32_t field = cbelow(c, K(C_FENTRY, 0, 0), ENC ? (uint32_t)(e[0] | (e[1] << 8)) : 0, ir->field_count + 1);
      uint32_t child = cnum(c, K(C_FENTRY, 1, 0), ENC ? e[2] : 0);
      uint32_t inherited = (uint32_t)cbit(c, K(C_FENTRY, 2, 0), ENC && e[3]);
      if (!ENC) {
        uint8_t *d = ir->field_map_entries.data + ir->field_map_entries.len;
        d[0] = (uint8_t)field;
        d[1] = (uint8_t)(field >> 8);
        d[2] = (uint8_t)child;
        d[3] = (uint8_t)inherited;
        ir->field_map_entries.len += 4;
      }
    }
  }

  if (ir->has_external_scanner || ir->external_token_count) {
    code_u16s(c, C_EXT_SYM, &ir->external_symbol_map, ir->external_token_count);
  }

  if (ir->abi_version >= 15) {
    ir->reserved_set_count = chdr(c, 102, ir->reserved_set_count);
    code_u16s(c, C_RESERVED, &ir->reserved_words, ir->reserved_set_count * ir->max_reserved_word_set_size);
    code_u16s(c, C_SUPER, &ir->supertype_symbols, ir->supertype_count);
    ir->supertype_slice_count = chdr(c, 103, ir->supertype_slice_count);
    code_u16s(c, C_SUPER + 100, &ir->supertype_map_slices, ir->supertype_slice_count * 2);
    uint32_t n = chdr(c, 104, ir->supertype_map_entries.len);
    code_u16s(c, C_SUPER + 101, &ir->supertype_map_entries, n);
  }
}

static void code_external_states(Codec *c, IR *ir) {
  if (!ir->external_token_count) return;
  ir->ext_state_count = chdr(c, 105, ir->ext_state_count);
  uint32_t n = ir->ext_state_count * ir->external_token_count;
  if (!ENC && !VRESERVE(c, ir->external_states, n)) return;
  for (uint32_t i = 0; i < n && !c->failed; i++) {
    uint32_t col = i % ir->external_token_count;
    int b = cbit(c, K(C_EXT_STATE, col, 0), ENC && ir->external_states.data[i]);
    if (!ENC) ir->external_states.data[ir->external_states.len++] = (uint8_t)b;
  }
}

static void code_reduce_actions(Codec *c, IR *ir) {
  uint32_t n = chdr(c, 110, ir->red_acts.len);
  if (!ENC && !VRESERVE(c, ir->red_acts, n)) return;
  RedAct prev = {0};
  for (uint32_t i = 0; i < n && !c->failed; i++) {
    RedAct a = ENC ? ir->red_acts.data[i] : (RedAct){0};
    // Sorted by symbol, so code the symbol as a delta.
    uint32_t dsym = cnum(c, K(C_RED_SYM, 0, 0), ENC ? (uint32_t)(a.symbol - prev.symbol) : 0);
    a.symbol = (uint16_t)(prev.symbol + dsym);
    a.child_count = (uint8_t)cnum(c, K(C_RED_CC, dsym == 0, 0), a.child_count);
    uint32_t dp = cnum(c, K(C_RED_DP, 0, 0), ENC ? (uint32_t)((int32_t)a.dynamic_precedence * 2 ^ ((int32_t)a.dynamic_precedence >> 31)) : 0);
    a.dynamic_precedence = (int16_t)((dp >> 1) ^ (uint32_t)-(int32_t)(dp & 1));
    a.production_id = (uint16_t)cnum(c, K(C_RED_PID, 0, 0), a.production_id);
    if (!ENC) ir->red_acts.data[ir->red_acts.len++] = a;
    prev = a;
  }
}

static void code_rank(Codec *c, IR *ir) {
  uint32_t n = ir->symbol_count;
  if (!ENC && !VRESERVE(c, ir->rank_order, n)) return;
  uint8_t *used = calloc(n ? n : 1, 1);
  if (!used) {
    MARK_FAILED(c);
    return;
  }
  uint32_t prev = UINT32_MAX;
  for (uint32_t i = 0; i < n && !c->failed; i++) {
    uint32_t s = ENC ? ir->rank_order.data[i] : 0;
    uint32_t guess = prev + 1;
    while (guess < n && used[guess]) guess++;
    int hit = cbit(c, K(C_RANK_NEXT, 0, 0), guess < n && s == guess);
    if (hit) {
      s = guess;
    } else {
      s = cbelow(c, K(C_RANK_SYM, 0, 0), s, n);
    }
    if (s >= n) {
      MARK_FAILED(c);
      break;
    }
    used[s] = 1;
    if (!ENC) ir->rank_order.data[ir->rank_order.len++] = (uint16_t)s;
    prev = s;
  }
  free(used);
}

static void code_overlap(Codec *c, IR *ir) {
  uint32_t pos = 0;
  for (uint32_t x = 0; x < ir->token_count && !c->failed; x++) {
    uint32_t n = ENC ? ir->overlap.data[pos] : 0;
    n = cnum(c, K(C_OVL_N, 0, 0), n);
    if (!ENC) VPUSH(c, ir->overlap, (uint16_t)n);
    pos++;
    for (uint32_t i = 0; i < n && !c->failed; i++) {
      uint32_t y = ENC ? ir->overlap.data[pos] : 0;
      y = cbelow(c, K(C_OVL_TOK, 0, 0), y, ir->token_count);
      if (!ENC) VPUSH(c, ir->overlap, (uint16_t)y);
      pos++;
    }
  }
}

// ---------------------------------------------------------------------------
// Parse table model

typedef struct {
  uint32_t state;
  uint32_t score;
} Agree;

// Trie of the (symbol, target) sequences of each core's states.
typedef struct {
  uint32_t key;    // symbol << 16 | target
  uint32_t count;  // states that passed through this node
  uint32_t child;  // first child, or 0
  uint32_t next;   // next sibling, or 0
} TNode;

typedef struct {
  // per state
  uint32_t *core;     // core index, NONE until discovered
  uint32_t *memidx;   // index within its core's member list
  // per core
  VEC(U32Vec) members;
  U32Vec refcore;
  uint32_t *struct_id;   // states with equal ids have identical transition symbols
  uint32_t num_structs;
  VEC(U32Vec) post_by_target;  // target state -> states with a transition to it
  CandsVec mem_cands;   // per target core: recent member indices
  CandsVec core_cands;  // per symbol: recent target cores
  CandsVec la_cands;    // per reduce action: recent lookahead sets
  Map lexmode_by_valid;  // valid-terminal-set hash -> packed lex mode
  // encoder only: generator core id (primary state) -> core index
  uint32_t *core_of_primary;
  const uint16_t *primary;
  uint32_t num_cores;
  // agreement: states sharing a target with the current state's coded
  // transitions, kept sorted by score with O(1) increments (agree_start[s] =
  // number of entries scoring more than s)
  VEC(TNode) trie;        // node 0 is unused; roots per core in trie_root
  U32Vec trie_root;
  uint32_t *agree_stamp;
  uint32_t *agree_pos;
  U32Vec agree_start;
  uint32_t agree_max;
  // scratch
  VEC(Agree) agree;
  U16Vec tmp;
  U16Vec tmp2;
  U16Vec valid;       // terminals with an action in the current state (sorted)
  U16Vec tmp3;
  uint8_t *mark;      // per symbol scratch
} PModel;

static const Trans *state_trans(const IR *ir, uint32_t s, uint32_t *n) {
  *n = ir->states.data[s].trans_n;
  return ir->trans.data + ir->states.data[s].trans_off;
}

// Target of state `s` on symbol `x`, or NONE.
static uint32_t trans_target(const IR *ir, uint32_t s, uint16_t x) {
  uint32_t n;
  const Trans *t = state_trans(ir, s, &n);
  uint32_t lo = 0, hi = n;
  while (lo < hi) {
    uint32_t mid = (lo + hi) / 2;
    if (t[mid].sym < x) lo = mid + 1;
    else hi = mid;
  }
  return lo < n && t[lo].sym == x ? t[lo].target : NONE;
}

static const Trans *trans_find(const IR *ir, uint32_t s, uint16_t x) {
  uint32_t n;
  const Trans *t = state_trans(ir, s, &n);
  uint32_t lo = 0, hi = n;
  while (lo < hi) {
    uint32_t mid = (lo + hi) / 2;
    if (t[mid].sym < x) lo = mid + 1;
    else hi = mid;
  }
  return lo < n && t[lo].sym == x ? &t[lo] : NULL;
}

static void add_member(Codec *c, PModel *m, uint32_t core, uint32_t state) {
  while (m->members.len <= core) {
    if (!VPUSH(c, m->members, ((U32Vec){0}))) return;
    if (!VPUSH(c, m->refcore, NONE)) return;
  }
  m->memidx[state] = m->members.data[core].len;
  m->core[state] = core;
  VPUSH(c, m->members.data[core], state);
}

// Encoder: core index for a state, assigning the next one if it's new.
static bool enc_core_is_new(PModel *m, uint32_t state) {
  return m->core_of_primary[m->primary[state]] == NONE;
}

static uint32_t enc_assign_core(PModel *m, uint32_t state) {
  uint32_t *slot = &m->core_of_primary[m->primary[state]];
  if (*slot == NONE) *slot = m->num_cores++;
  return *slot;
}

// Code a sorted set of symbols in [lo, hi) as the positions where it differs
// from a sorted reference set: a count, then the gaps between them. Leaves
// the set in `out`.
static void code_set_diff(
  Codec *c, uint32_t comp, const uint16_t *set, uint32_t set_n, const uint16_t *ref, uint32_t ref_n,
  uint32_t lo, uint32_t hi, U16Vec *out
) {
  // Encoder: collect toggled symbols (symmetric difference).
  uint16_t stack_diff[256];
  uint16_t *diff = stack_diff;
  uint32_t nd = 0;
  if (c->enc) {
    if (set_n + ref_n > 256) {
      diff = malloc((set_n + ref_n) * sizeof(uint16_t));
      if (!diff) {
        MARK_FAILED(c);
        return;
      }
    }
    uint32_t a = 0, b = 0;
    while (a < set_n || b < ref_n) {
      if (b >= ref_n || (a < set_n && set[a] < ref[b])) {
        diff[nd++] = set[a++];
      } else if (a >= set_n || ref[b] < set[a]) {
        diff[nd++] = ref[b++];
      } else {
        a++;
        b++;
      }
    }
  }
  nd = cnum(c, K(comp, 1, ref_n == 0), nd);
  out->len = 0;
  uint32_t prev = lo, ri = 0;
  for (uint32_t i = 0; i < nd && !c->failed; i++) {
    // Gap to the next toggled symbol, conditioned on whether the reference
    // has the symbol right after the previous one (runs tend to continue).
    uint32_t gap = cnum(c, K(comp, 2, i == 0), c->enc ? diff[i] - prev : 0);
    uint32_t y = prev + gap;
    if (y >= hi) {
      MARK_FAILED(c);
      break;
    }
    // copy reference symbols below y, toggle y
    while (ri < ref_n && ref[ri] < y) VPUSH(c, *out, ref[ri++]);
    if (ri < ref_n && ref[ri] == y) {
      ri++;
    } else {
      VPUSH(c, *out, (uint16_t)y);
    }
    prev = y + 1;
  }
  while (ri < ref_n) VPUSH(c, *out, ref[ri++]);
  if (diff != stack_diff) free(diff);
}

// Code a set of symbols in [lo, hi) relative to a reference set: one bit per
// symbol, conditioned on whether the reference has it.
static uint32_t code_set_vs(
  Codec *c, SetPool *pool, uint32_t which, uint32_t id, const uint16_t *ref, uint32_t ref_n,
  uint32_t lo, uint32_t hi, PModel *m
) {
  const uint16_t *s = ENC ? pool_items(pool, id) : NULL;
  uint32_t sn = ENC ? pool->lens.data[id] : 0;
  code_set_diff(c, C_SET_BIT + which * 0, s, sn, ref, ref_n, lo, hi, &m->tmp);
  (void)which;
  return ENC ? id : pool_intern(c, pool, m->tmp.data, m->tmp.len);
}

static uint32_t code_misc_set(
  Codec *c, IR *ir, PModel *m, uint32_t which, uint32_t id, uint32_t ref_id, bool has_ref, uint32_t lo, uint32_t hi
) {
  SetPool *pool = &ir->misc_pool;
  int same = cbitf(c, C_SET_SAME, which * 2 + has_ref, id == ref_id);
  if (same) return ref_id;
  return code_set_vs(c, pool, which, id, pool_items(pool, ref_id), pool->lens.data[ref_id], lo, hi, m);
}

static bool same_structure(const IR *ir, uint32_t a, uint32_t b) {
  const PState *sa = &ir->states.data[a], *sb = &ir->states.data[b];
  if (sa->trans_n != sb->trans_n || sa->red_n != sb->red_n) return false;
  if (sa->selfg != sb->selfg || sa->extras != sb->extras || sa->acc != sb->acc || sa->rec != sb->rec) return false;
  for (uint32_t i = 0; i < sa->trans_n; i++) {
    const Trans *ta = &ir->trans.data[sa->trans_off + i], *tb = &ir->trans.data[sb->trans_off + i];
    if (ta->sym != tb->sym || ta->rep != tb->rep) return false;
  }
  for (uint32_t i = 0; i < sa->red_n; i++) {
    if (ir->reds.data[sa->red_off + i].red != ir->reds.data[sb->red_off + i].red) return false;
  }
  return true;
}

static void push_trans_syms(Codec *c, IR *ir, PState *st, const uint16_t *syms, uint32_t n) {
  st->trans_off = ir->trans.len;
  st->trans_n = n;
  for (uint32_t i = 0; i < n; i++) VPUSH(c, ir->trans, ((Trans){syms[i], 0, 0}));
}

static void code_reduce_set(Codec *c, IR *ir, PModel *m, uint32_t k, uint32_t ref) {
  PState *st = &ir->states.data[k];
  const Red *ref_reds = ref != NONE ? ir->reds.data + ir->states.data[ref].red_off : NULL;
  uint32_t ref_n = ref != NONE ? ir->states.data[ref].red_n : 0;
  const Red *mine = ENC ? ir->reds.data + st->red_off : NULL;
  uint32_t mine_n = ENC ? st->red_n : 0;
  m->tmp.len = 0;
  // Which of the reference's reduce actions this state has.
  uint32_t kept = 0;
  for (uint32_t i = 0; i < ref_n; i++) {
    int present = ENC && 0;
    if (ENC) {
      for (uint32_t j = 0; j < mine_n; j++) {
        if (mine[j].red == ref_reds[i].red) present = 1;
      }
    }
    present = cbitf(c, C_RED_IN, 0, present);
    if (present) {
      VPUSH(c, m->tmp, ref_reds[i].red);
      kept++;
    }
  }
  uint32_t extra = cnum(c, K(C_RED_EXTRA_N, ref != NONE, 0), ENC ? mine_n - kept : 0);
  uint32_t prev = 0;
  uint32_t ei = 0;
  for (uint32_t e = 0; e < extra && !c->failed; e++) {
    uint32_t id = 0;
    if (ENC) {
      // the e-th of this state's reduce ids that isn't in the reference
      for (; ei < mine_n; ei++) {
        bool in_ref = false;
        for (uint32_t i = 0; i < ref_n; i++) {
          if (ref_reds[i].red == mine[ei].red) in_ref = true;
        }
        if (!in_ref) break;
      }
      id = mine[ei++].red;
    }
    uint32_t d = cnum(c, K(C_RED_EXTRA, 0, 0), ENC ? id - prev : 0);
    id = prev + d;
    VPUSH(c, m->tmp, (uint16_t)id);
    prev = id + 1;
  }
  if (!ENC) {
    // sort ascending (insertion sort; reduce lists are short)
    for (uint32_t i = 1; i < m->tmp.len; i++) {
      uint16_t v = m->tmp.data[i];
      uint32_t j = i;
      while (j > 0 && m->tmp.data[j - 1] > v) {
        m->tmp.data[j] = m->tmp.data[j - 1];
        j--;
      }
      m->tmp.data[j] = v;
    }
    st->red_off = ir->reds.len;
    st->red_n = m->tmp.len;
    for (uint32_t i = 0; i < m->tmp.len; i++) VPUSH(c, ir->reds, ((Red){m->tmp.data[i], 0}));
  }
}

// Code the structure of state k: its transition symbols and their repetition
// flags, reduce actions, and extra/accept/recover sets.
static void code_structure(Codec *c, IR *ir, PModel *m, uint32_t k, uint32_t prev_member) {
  PState *st = &ir->states.data[k];
  uint32_t S = ir->symbol_count, T = ir->token_count;
  uint32_t empty = 0;  // misc pool id 0 is the empty set
  uint32_t r = prev_member;

  if (r != NONE) {
    int same = cbitf(c, C_SAME, 0, ENC && same_structure(ir, k, r));
    if (same) {
      m->struct_id[k] = m->struct_id[r];
      if (!ENC) {
        const PState *sr = &ir->states.data[r];
        st->trans_off = ir->trans.len;
        st->trans_n = sr->trans_n;
        for (uint32_t i = 0; i < sr->trans_n; i++) {
          Trans t = ir->trans.data[sr->trans_off + i];
          t.target = 0;
          VPUSH(c, ir->trans, t);
        }
        st->red_off = ir->reds.len;
        st->red_n = sr->red_n;
        for (uint32_t i = 0; i < sr->red_n; i++) {
          VPUSH(c, ir->reds, ((Red){ir->reds.data[sr->red_off + i].red, 0}));
        }
        st->selfg = sr->selfg;
        st->extras = sr->extras;
        st->acc = sr->acc;
        st->rec = sr->rec;
      }
      return;
    }
  }

  m->struct_id[k] = ++m->num_structs;

  // Transition symbols.
  uint32_t ref_core_state = NONE;
  {
    const uint16_t *ref = NULL;
    uint32_t ref_n = 0;
    if (r != NONE) {
      uint32_t n;
      const Trans *t = state_trans(ir, r, &n);
      m->tmp2.len = 0;
      for (uint32_t i = 0; i < n; i++) VPUSH(c, m->tmp2, t[i].sym);
      ref = m->tmp2.data;
      ref_n = m->tmp2.len;
      ref_core_state = r;
    } else {
      // First state of its core: reference the most similar recent core.
      uint32_t ncand = m->num_cores > 512 ? 512 : m->num_cores;
      uint32_t C = m->core[k];
      uint32_t choice = 0;  // 0 = no reference, j = j-th most recent core
      if (ENC && ncand) {
        uint32_t mine_n;
        const Trans *mine = state_trans(ir, k, &mine_n);
        uint32_t best = mine_n;
        for (uint32_t j = 1; j <= ncand; j++) {
          uint32_t core = m->num_cores - j;
          if (core == C || m->members.data[core].len == 0) continue;
          uint32_t first = m->members.data[core].data[0];
          if (first >= k) continue;
          uint32_t on;
          const Trans *o = state_trans(ir, first, &on);
          uint32_t a = 0, b = 0, diff = 0;
          while ((a < mine_n || b < on) && diff < best) {
            if (b >= on || (a < mine_n && mine[a].sym < o[b].sym)) {
              diff++;
              a++;
            } else if (a >= mine_n || o[b].sym < mine[a].sym) {
              diff++;
              b++;
            } else {
              a++;
              b++;
            }
          }
          if (diff < best) {
            best = diff;
            choice = j;
          }
        }
      }
      int has = cbitf(c, C_HASREF, 0, choice != 0);
      if (has) {
        choice = 1 + cbelow(c, K(C_REFIDX, 0, 0), choice - 1, ncand);
        uint32_t core = m->num_cores - choice;
        if (core >= m->members.len || m->members.data[core].len == 0) {
          MARK_FAILED(c);
          return;
        }
        uint32_t first = m->members.data[core].data[0];
        if (first >= k) {
          MARK_FAILED(c);
          return;
        }
        m->refcore.data[C] = core;
        uint32_t n;
        const Trans *t = state_trans(ir, first, &n);
        m->tmp2.len = 0;
        for (uint32_t i = 0; i < n; i++) VPUSH(c, m->tmp2, t[i].sym);
        ref = m->tmp2.data;
        ref_n = m->tmp2.len;
        ref_core_state = first;
      }
    }

    // Code the symbols as a diff against the reference.
    m->tmp3.len = 0;
    if (ENC) {
      uint32_t mine_n;
      const Trans *mine = state_trans(ir, k, &mine_n);
      for (uint32_t i = 0; i < mine_n; i++) VPUSH(c, m->tmp3, mine[i].sym);
    }
    code_set_diff(c, C_TRANS_BIT, m->tmp3.data, m->tmp3.len, ref, ref_n, 0, S, &m->tmp);
    if (!ENC) push_trans_syms(c, ir, st, m->tmp.data, m->tmp.len);
  }

  // Repetition flags of terminal shifts.
  for (uint32_t i = 0; i < st->trans_n && !c->failed; i++) {
    Trans *t = &ir->trans.data[st->trans_off + i];
    if (t->sym >= T) break;
    int pred = 2;
    if (ref_core_state != NONE) {
      const Trans *o = trans_find(ir, ref_core_state, t->sym);
      if (o) pred = o->rep;
    }
    t->rep = (uint8_t)cbitf(c, C_REP, (uint32_t)pred, ENC && t->rep);
  }

  // Reduce actions.
  code_reduce_set(c, ir, m, k, ref_core_state);

  // Extras, accept and recover sets, against the previous member or else the
  // previous state.
  uint32_t ms = r != NONE ? r : (k > 0 ? k - 1 : NONE);
  const PState *ps = ms != NONE ? &ir->states.data[ms] : NULL;
  st->selfg = code_misc_set(c, ir, m, 0, st->selfg, ps ? ps->selfg : empty, ps != NULL, T, S);
  st->extras = code_misc_set(c, ir, m, 1, st->extras, ps ? ps->extras : empty, ps != NULL, 0, T);
  st->acc = code_misc_set(c, ir, m, 2, st->acc, ps ? ps->acc : empty, ps != NULL, 0, T);
  st->rec = code_misc_set(c, ir, m, 3, st->rec, ps ? ps->rec : empty, ps != NULL, 0, T);
}

// How many recent states sharing a target feed the agreement scores, and how
// many of the best-scoring states are tried for a prediction.
#ifndef AGREE_POST
#define AGREE_POST 8
#endif
#ifndef AGREE_SCAN
#define AGREE_SCAN 16
#endif

static void agree_reset(PModel *m) {
  m->agree.len = 0;
  m->agree_max = 0;
  if (m->agree_start.cap) m->agree_start.data[0] = 0;
}

static void agree_add(Codec *c, PModel *m, uint32_t k, uint32_t state) {
  uint32_t i;
  if (m->agree_stamp[state] != k + 1) {
    m->agree_stamp[state] = k + 1;
    i = m->agree.len;
    if (!VPUSH(c, m->agree, ((Agree){state, 0}))) return;
    m->agree_pos[state] = i;
    m->agree_start.data[0] = m->agree.len - 1;
  } else {
    i = m->agree_pos[state];
  }
  uint32_t s = m->agree.data[i].score;
  if (s + 1 > m->agree_max) {
    if (!VRESERVE(c, m->agree_start, s + 3)) return;
    m->agree_start.data[s + 1] = 0;
    m->agree_max = s + 1;
  }
  // Swap to the front of score s's run, then grow score s+1's run over it.
  uint32_t f = m->agree_start.data[s];
  Agree moved = m->agree.data[f];
  m->agree.data[f] = m->agree.data[i];
  m->agree.data[i] = moved;
  m->agree_pos[moved.state] = i;
  m->agree_pos[state] = f;
  m->agree.data[f].score = s + 1;
  m->agree_start.data[s] = f + 1;
}

// Core of the target of an earlier state of core `C` on symbol `x`, or NONE.
static uint32_t skeleton_core(const IR *ir, const PModel *m, uint32_t C, uint16_t x, uint32_t k) {
  if (C >= m->members.len || m->members.data[C].len == 0) return NONE;
  uint32_t first = m->members.data[C].data[0];
  if (first >= k) return NONE;
  uint32_t t = trans_target(ir, first, x);
  return t == NONE ? NONE : m->core[t];
}

static Cands *cands_at(Codec *c, CandsVec *v, uint32_t i) {
  static Cands dummy;
  if (i >= v->len) {
    if (!VRESERVE(c, *v, i + 1)) {
      memset(&dummy, 0, sizeof dummy);
      return &dummy;
    }
    v->len = i + 1;
  }
  return &v->data[i];
}

// Code an existing core for the target of (core C, symbol x).
static uint32_t code_existing_core(Codec *c, IR *ir, PModel *m, uint32_t C, uint16_t x, uint32_t pred, uint32_t tc, uint32_t k) {
  uint32_t cand[2];
  uint32_t nc = 0;
  uint32_t R = C < m->refcore.len ? m->refcore.data[C] : NONE;
  if (R != NONE) {
    uint32_t v = skeleton_core(ir, m, R, x, k);
    if (v != NONE) cand[nc++] = v;
  }
  if (pred != NONE && m->core[pred] != NONE && (nc == 0 || cand[0] != m->core[pred])) cand[nc++] = m->core[pred];
  for (uint32_t j = 0; j < nc; j++) {
    int hit = cbitf(c, C_CORE_CAND, j, ENC && tc == cand[j]);
    if (hit) return cand[j];
  }
  Cands *cl = cands_at(c, &m->core_cands, x);
  int i = cands_code(c, cl, C_CORE_LIST, tc);
  if (i >= 0) {
    tc = cl->vals[i];
  } else {
    tc = cbelow(c, K(C_CORE_RAW, 0, 0), tc, m->num_cores);
  }
  cands_update(cl, i, tc);
  return tc;
}

static void code_targets(Codec *c, IR *ir, PModel *m, uint32_t k, uint32_t *next_new) {
  PState *st = &ir->states.data[k];
  uint32_t C = m->core[k];
  uint32_t sid = m->struct_id[k];
  uint32_t idx_k = m->memidx[k];
  uint32_t r0 = idx_k > 0 ? m->members.data[C].data[idx_k - 1] : NONE;
  bool r0_aligned = r0 != NONE && m->struct_id[r0] == sid;

  // Walk this core's trie alongside the transitions, extending it with this
  // state's (symbol, target) sequence.
  if (m->trie.len == 0) VPUSH(c, m->trie, ((TNode){0, 0, 0, 0}));
  while (m->trie_root.len <= C) VPUSH(c, m->trie_root, 0);
  if (m->trie_root.data[C] == 0) {
    VPUSH(c, m->trie, ((TNode){0, 0, 0, 0}));
    m->trie_root.data[C] = m->trie.len - 1;
  }
  uint32_t node = m->trie_root.data[C];
  m->trie.data[node].count++;

  agree_reset(m);
  if (!VRESERVE(c, m->agree_start, 4)) return;
  m->agree_start.data[0] = 0;
  uint32_t agree_upto = 0;

  for (uint32_t ti = 0; ti < st->trans_n && !c->failed; ti++) {
    Trans *tr = &ir->trans.data[st->trans_off + ti];
    uint16_t x = tr->sym;
    uint32_t t = ENC ? tr->target : 0;
    uint32_t skc;
    if (r0_aligned) {
      skc = m->core[ir->trans.data[ir->states.data[r0].trans_off + ti].target];
    } else {
      uint32_t rt = r0 != NONE ? trans_target(ir, r0, x) : NONE;
      skc = rt != NONE ? m->core[rt] : skeleton_core(ir, m, C, x, k);
    }
    int known = skc != NONE;

    // Predict: the most common next target among earlier states of this core
    // that agree so far, else a target of an earlier state of any core that
    // shares this state's targets so far.
    uint32_t pred = NONE;
    uint32_t src = 0;
    {
      uint32_t best = 0, best_count = 0, distinct = 0;
      for (uint32_t ch = m->trie.data[node].child; ch; ch = m->trie.data[ch].next) {
        const TNode *n = &m->trie.data[ch];
        if ((n->key >> 16) != x) continue;
        distinct++;
        if (n->count > best_count) {
          best = ch;
          best_count = n->count;
        }
      }
      if (best) {
        pred = m->trie.data[best].key & 0xFFFF;
        src = distinct > 1 ? 2 : 1;
      }
    }
    if (pred == NONE) {
      for (; agree_upto < ti; agree_upto++) {
        const Trans *pt = &ir->trans.data[st->trans_off + agree_upto];
        U32Vec *pl = &m->post_by_target.data[pt->target];
        // The 8 most recent other states (this one may be listed last).
        uint32_t end = pl->len && pl->data[pl->len - 1] == k ? pl->len - 1 : pl->len;
        uint32_t from = end > AGREE_POST ? end - AGREE_POST : 0;
        for (uint32_t i = end; i > from; i--) agree_add(c, m, k, pl->data[i - 1]);
      }
      uint32_t scan = m->agree.len < AGREE_SCAN ? m->agree.len : AGREE_SCAN;
      for (uint32_t i = 0; i < scan; i++) {
        uint32_t v = trans_target(ir, m->agree.data[i].state, x);
        if (v != NONE) {
          pred = v;
          uint32_t sc = m->agree.data[i].score;
          src = 3 + (sc > 3 ? 3 : sc);
          break;
        }
      }
    }
    bool done = false;
    if (pred != NONE) {
      int hit = cbitf(c, C_P_HIT, src * 2 + (uint32_t)known, ENC && t == pred);
      if (hit) {
        t = pred;
        done = true;
      }
    }
    if (!done) {
      int isnew = cbitf(c, C_ISNEW, (pred == NONE ? 0 : 1 + src) * 2 + (uint32_t)known, ENC && t >= *next_new);
      if (isnew) {
        if (ENC && t != *next_new) {
          // States must be in canonical breadth-first order.
          MARK_FAILED(c);
          return;
        }
        t = (*next_new)++;
        if (t >= ir->state_count) {
          MARK_FAILED(c);
          return;
        }
        uint32_t tc = 0;
        bool resolved = false;
        if (known) {
          int ok = cbitf(c, C_SKEL_OK, 0, ENC && m->core_of_primary[m->primary[t]] == skc);
          if (ok) {
            tc = skc;
            resolved = true;
          }
        }
        if (!resolved) {
          int nc = cbitf(c, C_NEWCORE, (uint32_t)known, ENC && enc_core_is_new(m, t));
          if (nc) {
            tc = ENC ? enc_assign_core(m, t) : m->num_cores++;
          } else {
            tc = code_existing_core(c, ir, m, C, x, pred, ENC ? m->core_of_primary[m->primary[t]] : 0, k);
            if (tc >= m->num_cores) {
              MARK_FAILED(c);
              return;
            }
          }
        }
        add_member(c, m, tc, t);
      } else {
        uint32_t tc = 0;
        bool resolved = false;
        if (known) {
          int ok = cbitf(c, C_SKEL_OK, 1, ENC && m->core[t] == skc);
          if (ok) {
            tc = skc;
            resolved = true;
          }
        }
        if (!resolved) tc = code_existing_core(c, ir, m, C, x, pred, ENC ? m->core[t] : 0, k);
        if (tc >= m->members.len) {
          MARK_FAILED(c);
          return;
        }
        U32Vec *tm = &m->members.data[tc];
        uint32_t pred_idx = pred != NONE && m->core[pred] == tc ? m->memidx[pred] : NONE;
        uint32_t avail = tm->len - (pred_idx != NONE);
        uint32_t idx = 0;
        if (ENC) {
          idx = m->memidx[t];
          if (pred_idx != NONE && idx > pred_idx) idx--;
        }
        Cands *cl = cands_at(c, &m->mem_cands, tc);
        // Candidates are member indices; skip the (missed) prediction.
        int ci = -1;
        for (int i = 0; i < cl->len; i++) {
          uint32_t cv = cl->vals[i];
          if (cv == pred_idx || cv >= tm->len) continue;
          uint32_t adj = pred_idx != NONE && cv > pred_idx ? cv - 1 : cv;
          int hit = cbitf(c, C_MEM_LIST, (uint32_t)(i < 3 ? i : 3), ENC && adj == idx);
          if (hit) {
            ci = i;
            idx = adj;
            break;
          }
        }
        if (ci < 0) idx = cbelow(c, K(C_MEM_RAW, 0, 0), idx, avail);
        uint32_t real = pred_idx != NONE && idx >= pred_idx ? idx + 1 : idx;
        if (real >= tm->len) {
          MARK_FAILED(c);
          return;
        }
        cands_update(cl, ci, real);
        t = tm->data[real];
      }
    }

    if (!ENC) tr->target = (uint16_t)t;
    U32Vec *post = &m->post_by_target.data[t];
    if (!post->len || post->data[post->len - 1] != k) VPUSH(c, *post, k);

    // Descend the trie.
    {
      uint32_t key = ((uint32_t)x << 16) | t;
      uint32_t ch = m->trie.data[node].child, last = 0;
      while (ch && m->trie.data[ch].key != key) {
        last = ch;
        ch = m->trie.data[ch].next;
      }
      if (!ch) {
        if (!VPUSH(c, m->trie, ((TNode){key, 0, 0, 0}))) return;
        ch = m->trie.len - 1;
        if (last) {
          m->trie.data[last].next = ch;
        } else {
          m->trie.data[node].child = ch;
        }
      }
      m->trie.data[ch].count++;
      node = ch;
    }
  }
}

static uint32_t set_diff_bounded(const uint16_t *a, uint32_t an, const uint16_t *b, uint32_t bn, uint32_t bound) {
  uint32_t i = 0, j = 0, diff = 0;
  while ((i < an || j < bn) && diff < bound) {
    if (j >= bn || (i < an && a[i] < b[j])) {
      diff++;
      i++;
    } else if (i >= an || b[j] < a[i]) {
      diff++;
      j++;
    } else {
      i++;
      j++;
    }
  }
  return diff;
}

// Code the lookahead set of each of state k's reduce actions.
static void code_la_sets(Codec *c, IR *ir, PModel *m, uint32_t k) {
  PState *st = &ir->states.data[k];
  uint32_t T = ir->token_count;
  SetPool *pool = &ir->la_pool;
  for (uint32_t i = 0; i < st->red_n && !c->failed; i++) {
    Red *rd = &ir->reds.data[st->red_off + i];
    const uint16_t *src = NULL;
    uint32_t src_n = 0;
    uint32_t la = NONE;
    if (ENC) {
      src = pool_items(&ir->src_la_pool, rd->la);
      src_n = ir->src_la_pool.lens.data[rd->la];
      la = pool_find(pool, src, src_n);
    }
    Cands *cl = cands_at(c, &m->la_cands, rd->red);
    int ci = cands_code(c, cl, C_LA_RED, la);
    if (ci >= 0) {
      la = cl->vals[ci];
    } else {
      uint32_t count = pool->offs.len;
      int glob = cbitf(c, C_LA_GLOB, 0, ENC && la != NONE);
      if (glob) {
        uint32_t back = cbelow(c, K(C_LA_GIDX, 0, 0), ENC ? count - 1 - la : 0, count);
        la = count - 1 - back;
      } else {
        // A new set, coded against the nearest recent set.
        uint32_t window = count > 2048 ? 2048 : count;
        uint32_t choice = 0;
        if (ENC) {
          uint32_t best = src_n;
          for (uint32_t j = 1; j <= window && best; j++) {
            uint32_t id = count - j;
            uint32_t d = set_diff_bounded(src, src_n, pool_items(pool, id), pool->lens.data[id], best);
            if (d < best) {
              best = d;
              choice = j;
            }
          }
        }
        choice = cbelow(c, K(C_LA_REF, 0, 0), choice, window + 1);
        const uint16_t *ref = NULL;
        uint32_t ref_n = 0;
        if (choice) {
          ref = pool_items(pool, count - choice);
          ref_n = pool->lens.data[count - choice];
        }
        code_set_diff(c, C_LA_BIT, src, src_n, ref, ref_n, 0, T, &m->tmp);
        la = pool_intern(c, pool, m->tmp.data, m->tmp.len);
      }
    }
    if (la >= pool->offs.len) {
      MARK_FAILED(c);
      return;
    }
    cands_update(cl, ci, la);
    rd->la = la;
  }
}

// Mark every terminal with an action in state k (with its action count in
// `count`); returns how many there are and leaves them, sorted, in m->valid.
static uint32_t valid_terminals(Codec *c, IR *ir, PModel *m, uint32_t k, uint8_t *count) {
  const PState *st = &ir->states.data[k];
  uint32_t T = ir->token_count;
  memset(count, 0, T);
  for (uint32_t i = 0; i < st->trans_n; i++) {
    uint16_t x = ir->trans.data[st->trans_off + i].sym;
    if (x < T) count[x]++;
  }
  const uint32_t sets[3] = {st->extras, st->acc, st->rec};
  for (int j = 0; j < 3; j++) {
    const uint16_t *s = pool_items(&ir->misc_pool, sets[j]);
    for (uint32_t i = 0; i < ir->misc_pool.lens.data[sets[j]]; i++) {
      if (s[i] < T) count[s[i]]++;
    }
  }
  for (uint32_t r = 0; r < st->red_n; r++) {
    uint32_t la = ir->reds.data[st->red_off + r].la;
    const uint16_t *s = pool_items(&ir->la_pool, la);
    for (uint32_t i = 0; i < ir->la_pool.lens.data[la]; i++) {
      if (s[i] < T && count[s[i]] < 255) count[s[i]]++;
    }
  }
  m->valid.len = 0;
  if (!VRESERVE(c, m->valid, T)) return 0;
  for (uint32_t x = 0; x < T; x++) {
    if (count[x]) m->valid.data[m->valid.len++] = (uint16_t)x;
  }
  return m->valid.len;
}

static void code_lex_mode(Codec *c, IR *ir, PModel *m, uint32_t k) {
  PState *st = &ir->states.data[k];
  uint64_t h = set_hash(m->valid.data, m->valid.len);
  uint32_t *slot = map_slot(c, &m->lexmode_by_valid, h);
  uint32_t pred = *slot;
  const PState *ps = pred != UINT32_MAX ? &ir->states.data[pred] : NULL;
  int hit = cbitf(
    c, C_LM_HIT, ps != NULL,
    ENC && ps && ps->lex_state == st->lex_state && ps->ext_lex_state == st->ext_lex_state &&
      ps->reserved_id == st->reserved_id
  );
  if (hit) {
    st->lex_state = ps->lex_state;
    st->ext_lex_state = ps->ext_lex_state;
    st->reserved_id = ps->reserved_id;
  } else {
    st->lex_state = (uint16_t)cnum(c, K(C_LM_LEX, 0, 0), st->lex_state);
    st->ext_lex_state = (uint16_t)cnum(c, K(C_LM_EXT, 0, 0), st->ext_lex_state);
    if (ir->abi_version >= 15) st->reserved_id = (uint16_t)cnum(c, K(C_LM_RES, 0, 0), st->reserved_id);
  }
  *slot = k;
}

// Cells whose action list isn't in canonical order (reduces by id, then
// accept, recover, shift, shift-extra). tree-sitter always emits that order
// today, so this normally costs nothing.
static void code_orders(Codec *c, IR *ir, PModel *m, uint32_t k) {
  PState *st = &ir->states.data[k];
  uint32_t n = m->valid.len;
  uint32_t ei = 0;
  if (!ENC) st->ord_off = ir->ords.len;
  for (uint32_t i = 0; i < n && !c->failed; i++) {
    uint16_t x = m->valid.data[i];
    uint32_t cnt = m->mark[x];
    if (cnt < 2) continue;
    const OrderExc *e = NULL;
    if (ENC && ei < st->ord_n && ir->ords.data[st->ord_off + ei].sym == x) e = &ir->ords.data[st->ord_off + ei++];
    int canon = cbitf(c, C_ORD, cnt < 4 ? cnt : 4, e == NULL);
    if (canon) continue;
    if (cnt > 8) {
      MARK_FAILED(c);
      return;
    }
    OrderExc d = {x, (uint8_t)cnt, {0}};
    uint8_t used[8] = {0};
    for (uint32_t p = 0; p < cnt; p++) {
      uint32_t rank = 0;
      if (ENC) {
        for (uint32_t q = 0; q < e->perm[p]; q++) rank += !used[q];
      }
      rank = cbelow(c, K(C_ORD_P, cnt, p), rank, cnt - p);
      uint32_t q = 0;
      for (;; q++) {
        if (used[q]) continue;
        if (rank-- == 0) break;
      }
      used[q] = 1;
      d.perm[p] = (uint8_t)q;
    }
    if (!ENC) {
      VPUSH(c, ir->ords, d);
      st->ord_n++;
    }
  }
}

// Code the terminals of state k whose reusable flag isn't the predicted one.
static void code_reusable_exceptions(Codec *c, IR *ir, PModel *m, uint32_t k) {
  PState *st = &ir->states.data[k];
  int any = cbitf(c, C_REUS_ANY, 0, ENC && st->reus_exc != 0);
  if (!any) {
    st->reus_exc = 0;
    return;
  }
  uint32_t n = m->valid.len;
  const uint16_t *exc = ENC ? pool_items(&ir->misc_pool, st->reus_exc) : NULL;
  uint32_t exc_n = ENC ? ir->misc_pool.lens.data[st->reus_exc] : 0;
  m->tmp2.len = 0;
  for (uint32_t i = 0; i < n && !c->failed; i++) {
    uint16_t x = m->valid.data[i];
    int flip = cbitf(c, C_REUS_BIT, 0, ENC && sorted_contains(exc, exc_n, x));
    if (flip) VPUSH(c, m->tmp2, x);
  }
  if (!ENC) st->reus_exc = pool_intern(c, &ir->misc_pool, m->tmp2.data, m->tmp2.len);
}

static bool pmodel_init(Codec *c, IR *ir, PModel *m) {
  uint32_t N = ir->state_count;
  memset(m, 0, sizeof(*m));
  m->core = malloc((N ? N : 1) * sizeof(uint32_t));
  m->memidx = malloc((N ? N : 1) * sizeof(uint32_t));
  m->mark = calloc(ir->symbol_count + 1, 1);
  m->agree_stamp = calloc(N ? N : 1, sizeof(uint32_t));
  m->agree_pos = calloc(N ? N : 1, sizeof(uint32_t));
  m->struct_id = calloc(N ? N : 1, sizeof(uint32_t));
  if (!m->core || !m->memidx || !m->mark || !m->agree_stamp || !m->agree_pos || !m->struct_id ||
      !VRESERVE(c, m->post_by_target, N ? N : 1)) {
    MARK_FAILED(c);
    return false;
  }
  for (uint32_t i = 0; i < N; i++) m->core[i] = m->memidx[i] = NONE;
  m->post_by_target.len = N;
  if (c->enc) {
    m->primary = ir->enc_primary;
    m->core_of_primary = malloc((N ? N : 1) * sizeof(uint32_t));
    if (!m->core_of_primary) {
      MARK_FAILED(c);
      return false;
    }
    for (uint32_t i = 0; i < N; i++) m->core_of_primary[i] = NONE;
  }
  return true;
}

static void pmodel_free(PModel *m) {
  free(m->core);
  free(m->memidx);
  free(m->mark);
  free(m->agree_stamp);
  free(m->agree_pos);
  VFREE(m->agree_start);
  VFREE(m->trie);
  VFREE(m->trie_root);
  free(m->core_of_primary);
  for (uint32_t i = 0; i < m->members.len; i++) VFREE(m->members.data[i]);
  VFREE(m->members);
  VFREE(m->refcore);
  for (uint32_t i = 0; i < m->post_by_target.len; i++) VFREE(m->post_by_target.data[i]);
  VFREE(m->post_by_target);
  free(m->struct_id);
  VFREE(m->mem_cands);
  VFREE(m->core_cands);
  VFREE(m->la_cands);
  map_free(&m->lexmode_by_valid);
  VFREE(m->agree);
  VFREE(m->tmp);
  VFREE(m->tmp2);
  VFREE(m->valid);
  VFREE(m->tmp3);
}

static void code_parse_states(Codec *c, IR *ir, PModel *m) {
  uint32_t N = ir->state_count;
  if (!ENC) {
    if (!VRESERVE(c, ir->states, N)) return;
    ir->states.len = N;
  }
  uint32_t next_new = N < 2 ? N : 2;
  for (uint32_t k = 0; k < N && !c->failed; k++) {
    if (k >= next_new) next_new = k + 1;
    if (m->core[k] == NONE) {
      // States 0 and 1, and states no earlier state shifts or goes to.
      int nc = cbitf(c, C_ROOT_NEW, 0, ENC && enc_core_is_new(m, k));
      uint32_t core;
      if (nc) {
        core = ENC ? enc_assign_core(m, k) : m->num_cores++;
      } else {
        core = cbelow(c, K(C_ROOT_CORE, 0, 0), ENC ? m->core_of_primary[m->primary[k]] : 0, m->num_cores);
      }
      add_member(c, m, core, k);
      if (c->failed) return;
    }
    uint32_t C = m->core[k];
    uint32_t idx = m->memidx[k];
    uint32_t prev_member = idx > 0 ? m->members.data[C].data[idx - 1] : NONE;
    code_structure(c, ir, m, k, prev_member);
    if (c->failed) return;
    code_targets(c, ir, m, k, &next_new);
    if (c->failed) return;
    code_la_sets(c, ir, m, k);
    valid_terminals(c, ir, m, k, m->mark);
    code_lex_mode(c, ir, m, k);
    code_orders(c, ir, m, k);
    code_reusable_exceptions(c, ir, m, k);
  }
}

// Order of every model section, shared by both directions.
static void code_all(Codec *c, IR *ir, PModel *m) {
  ir->abi_version = chdr(c, 0, ir->abi_version);
  ir->symbol_count = chdr(c, 1, ir->symbol_count);
  ir->alias_count = chdr(c, 2, ir->alias_count);
  ir->token_count = chdr(c, 3, ir->token_count);
  ir->external_token_count = chdr(c, 4, ir->external_token_count);
  ir->state_count = chdr(c, 5, ir->state_count);
  ir->production_id_count = chdr(c, 6, ir->production_id_count);
  ir->field_count = chdr(c, 7, ir->field_count);
  ir->max_alias_sequence_length = chdr(c, 8, ir->max_alias_sequence_length);
  ir->keyword_capture_token = chdr(c, 9, ir->keyword_capture_token);
  ir->max_reserved_word_set_size = chdr(c, 10, ir->max_reserved_word_set_size);
  ir->supertype_count = chdr(c, 11, ir->supertype_count);
  for (int i = 0; i < 3; i++) ir->metadata[i] = (uint8_t)chdr(c, 12 + i, ir->metadata[i]);
  uint32_t flags = ir->has_keyword_lex | ir->has_external_scanner << 1 | ir->has_field_map << 2 |
                   ir->has_alias_sequences << 3 | ir->has_alias_map << 4 | ir->has_name << 5;
  flags = chdr(c, 15, flags);
  ir->has_keyword_lex = flags & 1;
  ir->has_external_scanner = (flags >> 1) & 1;
  ir->has_field_map = (flags >> 2) & 1;
  ir->has_alias_sequences = (flags >> 3) & 1;
  ir->has_alias_map = (flags >> 4) & 1;
  ir->has_name = (flags >> 5) & 1;
  if (c->failed || ir->symbol_count > 65535 || ir->state_count > 65535 || ir->token_count > ir->symbol_count) {
    MARK_FAILED(c);
    return;
  }

  code_misc_tables(c, ir);
  code_external_states(c, ir);
  code_reduce_actions(c, ir);
  code_rank(c, ir);
  code_overlap(c, ir);
  if (c->failed) return;

  if (!ENC) {
    // misc pool id 0 is the empty set, in both directions
    pool_intern(c, &ir->misc_pool, NULL, 0);
  }
  if (!pmodel_init(c, ir, m)) return;
  code_parse_states(c, ir, m);
}

// ---------------------------------------------------------------------------
// Rendering: rebuild the generator's tables from the IR

typedef struct {
  TSLanguage *language;
  // owned arrays (kept alive with the language)
  TSParseActionEntry *parse_actions;
  uint32_t parse_action_count;
  uint16_t *small_parse_table;
  uint32_t small_parse_table_len;
  uint32_t *small_parse_table_map;
  void *lex_modes;
  uint16_t *primary_state_ids;
} Rendered;

typedef struct {
  uint32_t value;  // goto state or action list id
  uint16_t sym;
  uint8_t kind;    // 0 terminal, 1 non-terminal
} Cell;

typedef struct {
  uint32_t start, len;  // range in the sorted cell array
  uint32_t value;
  uint8_t kind;
} Group;

static int group_cmp(const void *a, const void *b) {
  const Group *x = a, *y = b;
  if (x->len != y->len) return x->len < y->len ? -1 : 1;
  if (x->kind != y->kind) return x->kind < y->kind ? -1 : 1;
  if (x->value != y->value) return x->value < y->value ? -1 : 1;
  return 0;
}

static void put_action(uint16_t *w, const TSParseAction *a) {
  uint8_t bytes[8];
  memcpy(bytes, a, 8);
  for (int i = 0; i < 4; i++) w[i] = (uint16_t)(bytes[2 * i] | (bytes[2 * i + 1] << 8));
}

static bool render_parse_table(Codec *c, IR *ir, Rendered *out) {
  uint32_t N = ir->state_count, T = ir->token_count, S = ir->symbol_count;
  bool ok = false;
  uint16_t *rank = malloc((S ? S : 1) * sizeof(uint16_t));
  uint32_t *valid_gen = calloc(T ? T : 1, sizeof(uint32_t));
  // per-terminal action lists for the current state
  TSParseAction *acts = calloc((size_t)(T ? T : 1) * 8, sizeof(TSParseAction));
  uint16_t *red_of = calloc(T ? T : 1, sizeof(uint16_t));  // reduce id of a single-reduce cell
  uint8_t *nacts = calloc(T ? T : 1, 1);
  SetPool lists = {0};
  U32Vec list_offset = {0};
  VEC(TSParseActionEntry) pa = {0};
  U16Vec spt = {0};
  VEC(Cell) cells = {0};
  VEC(Group) groups = {0};
  U16Vec key = {0};
  uint32_t *map = malloc((N ? N : 1) * sizeof(uint32_t));
  // Group lookup by value: action list offsets (< 65536) then goto states.
  enum { T_VALUES = 65536 };
  uint32_t gstamp_len = T_VALUES + N;
  uint32_t *gstamp = calloc(gstamp_len, sizeof(uint32_t));
  uint32_t *gindex = malloc(gstamp_len * sizeof(uint32_t));
  // Action list ids for single-action lists, by (action, reusable).
  uint32_t nred = ir->red_acts.len;
  uint32_t *red_cache = malloc((size_t)(nred ? nred : 1) * 2 * sizeof(uint32_t));
  uint32_t *shift_cache = malloc((size_t)(N ? N : 1) * 4 * sizeof(uint32_t));
  uint32_t extra_cache[2] = {NONE, NONE};
  if (!rank || !valid_gen || !acts || !nacts || !map || !red_cache || !shift_cache || !gstamp || !gindex) goto done;
  memset(red_cache, 0xff, (size_t)(nred ? nred : 1) * 2 * sizeof(uint32_t));
  memset(shift_cache, 0xff, (size_t)(N ? N : 1) * 4 * sizeof(uint32_t));

  for (uint32_t i = 0; i < S; i++) rank[i] = 0;
  for (uint32_t i = 0; i < ir->rank_order.len; i++) rank[ir->rank_order.data[i]] = (uint16_t)i;

  // Overlap lists, indexed by token.
  U32Vec ovl_off = {0};
  {
    uint32_t pos = 0;
    for (uint32_t x = 0; x < T; x++) {
      VPUSH(c, ovl_off, pos);
      pos += 1 + ir->overlap.data[pos];
    }
  }

  // Action list 0 is the empty list.
  {
    TSParseActionEntry e;
    memset(&e, 0, sizeof e);
    VPUSH(c, pa, e);
    uint16_t empty_key[2] = {0, 0};
    pool_intern(c, &lists, empty_key, 2);
    VPUSH(c, list_offset, 0);
  }

  for (uint32_t k = 0; k < N && !c->failed; k++) {
    const PState *st = &ir->states.data[k];
    memset(nacts, 0, T);
    // Canonical action order: reduces by id, accept, recover, shift, extra.
    for (uint32_t r = 0; r < st->red_n; r++) {
      const Red *rd = &ir->reds.data[st->red_off + r];
      const RedAct *ra = &ir->red_acts.data[rd->red];
      const uint16_t *s = pool_items(&ir->la_pool, rd->la);
      for (uint32_t i = 0; i < ir->la_pool.lens.data[rd->la]; i++) {
        uint16_t x = s[i];
        if (x >= T || nacts[x] >= 8) goto done;
        red_of[x] = rd->red;
        TSParseAction *a = &acts[x * 8 + nacts[x]++];
        memset(a, 0, sizeof *a);
        a->reduce.type = TSParseActionTypeReduce;
        a->reduce.child_count = ra->child_count;
        a->reduce.symbol = ra->symbol;
        a->reduce.dynamic_precedence = ra->dynamic_precedence;
        a->reduce.production_id = ra->production_id;
      }
    }
    const uint32_t simple[2] = {st->acc, st->rec};
    for (int j = 0; j < 2; j++) {
      const uint16_t *s = pool_items(&ir->misc_pool, simple[j]);
      for (uint32_t i = 0; i < ir->misc_pool.lens.data[simple[j]]; i++) {
        uint16_t x = s[i];
        if (x >= T || nacts[x] >= 8) goto done;
        TSParseAction *a = &acts[x * 8 + nacts[x]++];
        memset(a, 0, sizeof *a);
        a->type = j == 0 ? TSParseActionTypeAccept : TSParseActionTypeRecover;
      }
    }
    for (uint32_t i = 0; i < st->trans_n; i++) {
      const Trans *t = &ir->trans.data[st->trans_off + i];
      if (t->sym >= T) break;
      if (nacts[t->sym] >= 8) goto done;
      TSParseAction *a = &acts[t->sym * 8 + nacts[t->sym]++];
      memset(a, 0, sizeof *a);
      a->shift.type = TSParseActionTypeShift;
      a->shift.state = t->target;
      a->shift.repetition = t->rep;
    }
    {
      const uint16_t *s = pool_items(&ir->misc_pool, st->extras);
      for (uint32_t i = 0; i < ir->misc_pool.lens.data[st->extras]; i++) {
        uint16_t x = s[i];
        if (x >= T || nacts[x] >= 8) goto done;
        TSParseAction *a = &acts[x * 8 + nacts[x]++];
        memset(a, 0, sizeof *a);
        a->shift.type = TSParseActionTypeShift;
        a->shift.extra = true;
      }
    }
    for (uint32_t e = 0; e < st->ord_n; e++) {
      const OrderExc *o = &ir->ords.data[st->ord_off + e];
      if (o->sym >= T || o->n != nacts[o->sym]) goto done;
      TSParseAction tmp[8];
      for (uint32_t p = 0; p < o->n; p++) tmp[p] = acts[o->sym * 8 + o->perm[p]];
      memcpy(&acts[o->sym * 8], tmp, o->n * sizeof(TSParseAction));
    }

    // Cells, in symbol order: terminals get action list ids by first use.
    cells.len = 0;
    uint32_t gen = k + 1;
    for (uint32_t x = 0; x < T; x++) {
      if (nacts[x]) valid_gen[x] = gen;
    }
    const uint16_t *exc = pool_items(&ir->misc_pool, st->reus_exc);
    uint32_t exc_n = ir->misc_pool.lens.data[st->reus_exc];
    for (uint32_t x = 0; x < T && !c->failed; x++) {
      if (!nacts[x]) continue;
      bool reusable = true;
      const uint16_t *o = ir->overlap.data + ovl_off.data[x];
      for (uint32_t i = 1; i <= o[0]; i++) {
        if (valid_gen[o[i]] == gen) {
          reusable = false;
          break;
        }
      }
      if (sorted_contains(exc, exc_n, (uint16_t)x)) reusable = !reusable;
      uint32_t *cache = NULL;
      if (nacts[x] == 1) {
        const TSParseAction *a = &acts[x * 8];
        if (a->type == TSParseActionTypeReduce) {
          cache = &red_cache[red_of[x] * 2 + reusable];
        } else if (a->type == TSParseActionTypeShift) {
          cache = a->shift.extra ? &extra_cache[reusable] : &shift_cache[(a->shift.state * 2u + a->shift.repetition) * 2 + reusable];
        }
      }
      if (cache && *cache != NONE) {
        if (*cache > 65535) goto done;
        VPUSH(c, cells, ((Cell){*cache, (uint16_t)x, 0}));
        continue;
      }
      key.len = 0;
      VPUSH(c, key, reusable);
      VPUSH(c, key, nacts[x]);
      if (!VRESERVE(c, key, 2 + 4u * nacts[x])) goto done;
      for (uint32_t i = 0; i < nacts[x]; i++) {
        put_action(key.data + key.len, &acts[x * 8 + i]);
        key.len += 4;
      }
      uint32_t id = pool_find(&lists, key.data, key.len);
      uint32_t offset;
      if (id == NONE) {
        offset = pa.len;
        TSParseActionEntry h;
        memset(&h, 0, sizeof h);
        h.entry.count = nacts[x];
        h.entry.reusable = reusable;
        VPUSH(c, pa, h);
        for (uint32_t i = 0; i < nacts[x]; i++) {
          TSParseActionEntry a;
          memset(&a, 0, sizeof a);
          a.action = acts[x * 8 + i];
          VPUSH(c, pa, a);
        }
        pool_intern(c, &lists, key.data, key.len);
        VPUSH(c, list_offset, offset);
      } else {
        offset = list_offset.data[id];
      }
      if (cache) *cache = offset;
      if (offset > 65535) goto done;
      VPUSH(c, cells, ((Cell){offset, (uint16_t)x, 0}));
    }
    // Non-terminal cells.
    for (uint32_t i = 0; i < st->trans_n; i++) {
      const Trans *t = &ir->trans.data[st->trans_off + i];
      if (t->sym < T) continue;
      VPUSH(c, cells, ((Cell){t->target, t->sym, 1}));
    }
    {
      const uint16_t *s = pool_items(&ir->misc_pool, st->selfg);
      for (uint32_t i = 0; i < ir->misc_pool.lens.data[st->selfg]; i++) {
        VPUSH(c, cells, ((Cell){k, s[i], 1}));
      }
    }
    if (c->failed) goto done;

    // Group by value, order groups as render.rs does, symbols by rank.
    groups.len = 0;
    for (uint32_t i = 0; i < cells.len; i++) {
      const Cell *cl = &cells.data[i];
      uint32_t slot = cl->kind ? (uint32_t)T_VALUES + cl->value : cl->value;
      if (slot >= gstamp_len) goto done;
      if (gstamp[slot] != k + 1) {
        gstamp[slot] = k + 1;
        gindex[slot] = groups.len;
        VPUSH(c, groups, ((Group){0, 0, cl->value, cl->kind}));
      }
      groups.data[gindex[slot]].len++;
    }
    if (c->failed) goto done;
    // (len, kind, value) ascending; groups per state are few
    for (uint32_t a = 1; a < groups.len; a++) {
      Group g = groups.data[a];
      uint32_t b = a;
      while (b > 0 && group_cmp(&groups.data[b - 1], &g) > 0) {
        groups.data[b] = groups.data[b - 1];
        b--;
      }
      groups.data[b] = g;
    }
    map[k] = spt.len;
    if (!VRESERVE(c, spt, spt.len + 1 + 2 * groups.len + cells.len)) goto done;
    spt.data[spt.len++] = (uint16_t)groups.len;
    for (uint32_t g = 0; g < groups.len; g++) {
      Group *gr = &groups.data[g];
      uint32_t slot = gr->kind ? (uint32_t)T_VALUES + gr->value : gr->value;
      gindex[slot] = g;
      spt.data[spt.len++] = (uint16_t)gr->value;
      spt.data[spt.len++] = (uint16_t)gr->len;
      gr->start = spt.len;
      spt.len += gr->len;
      gr->len = 0;
    }
    for (uint32_t i = 0; i < cells.len; i++) {
      const Cell *cl = &cells.data[i];
      uint32_t slot = cl->kind ? (uint32_t)T_VALUES + cl->value : cl->value;
      Group *gr = &groups.data[gindex[slot]];
      // insertion by rank; cells arrive in symbol order, which mostly matches
      uint16_t *syms = spt.data + gr->start;
      uint32_t b = gr->len++;
      while (b > 0 && rank[syms[b - 1]] > rank[cl->sym]) {
        syms[b] = syms[b - 1];
        b--;
      }
      syms[b] = cl->sym;
    }
  }
  if (c->failed) goto done;

  out->parse_actions = pa.data;
  out->parse_action_count = pa.len;
  pa.data = NULL;
  out->small_parse_table = spt.data;
  out->small_parse_table_len = spt.len;
  spt.data = NULL;
  out->small_parse_table_map = map;
  map = NULL;
  ok = true;

done:
  VFREE(ovl_off);
  free(rank);
  free(valid_gen);
  free(acts);
  free(gstamp);
  free(gindex);
  free(red_of);
  free(red_cache);
  free(shift_cache);
  free(nacts);
  free(map);
  pool_free(&lists);
  VFREE(list_offset);
  VFREE(pa);
  VFREE(spt);
  VFREE(cells);
  VFREE(groups);
  VFREE(key);
  if (!ok) MARK_FAILED(c);
  return ok;
}

static void *dup_array(const void *data, size_t bytes) {
  void *p = malloc(bytes ? bytes : 1);
  if (p && bytes) memcpy(p, data, bytes);
  return p;
}

// Build the TSLanguage from a decoded IR.
static TSLanguage *render_language(Codec *c, IR *ir, PModel *m, const TSPackedFunctions *fns) {
  Rendered r = {0};
  if (!render_parse_table(c, ir, &r)) return NULL;
  uint32_t N = ir->state_count;
  uint32_t nsym = ir->symbol_count + ir->alias_count;
  TSLanguage *L = calloc(1, sizeof(TSLanguage));
  if (!L) {
    MARK_FAILED(c);
    return NULL;
  }
  L->abi_version = ir->abi_version;
  L->symbol_count = ir->symbol_count;
  L->alias_count = ir->alias_count;
  L->token_count = ir->token_count;
  L->external_token_count = ir->external_token_count;
  L->state_count = N;
  L->large_state_count = 0;
  L->production_id_count = ir->production_id_count;
  L->field_count = ir->field_count;
  L->max_alias_sequence_length = (uint16_t)ir->max_alias_sequence_length;
  L->small_parse_table = r.small_parse_table;
  L->small_parse_table_map = r.small_parse_table_map;
  L->parse_actions = r.parse_actions;

  // Strings: one buffer, pointers into it.
  char *strings = dup_array(ir->strings.data, ir->strings.len);
  const char **names = calloc(nsym ? nsym : 1, sizeof(char *));
  const char **fields = calloc(ir->field_count + 1, sizeof(char *));
  if (!strings || !names || !fields) {
    MARK_FAILED(c);
    return NULL;
  }
  uint32_t pos = 0;
  for (uint32_t i = 0; i < nsym; i++) {
    names[i] = strings + pos;
    pos += (uint32_t)strlen(strings + pos) + 1;
  }
  for (uint32_t i = 1; i <= ir->field_count; i++) {
    fields[i] = strings + pos;
    pos += (uint32_t)strlen(strings + pos) + 1;
  }
  L->symbol_names = names;
  L->field_names = fields;
  if (ir->has_name) L->name = strings + pos;

  TSSymbolMetadata *meta = calloc(nsym ? nsym : 1, sizeof(TSSymbolMetadata));
  if (!meta) {
    MARK_FAILED(c);
    return NULL;
  }
  for (uint32_t i = 0; i < nsym; i++) {
    meta[i].visible = ir->symbol_metadata.data[i * 3];
    meta[i].named = ir->symbol_metadata.data[i * 3 + 1];
    meta[i].supertype = ir->symbol_metadata.data[i * 3 + 2];
  }
  L->symbol_metadata = meta;
  L->public_symbol_map = dup_array(ir->public_symbol_map.data, nsym * sizeof(uint16_t));
  if (ir->has_alias_map) L->alias_map = dup_array(ir->alias_map.data, ir->alias_map.len * sizeof(uint16_t));
  if (ir->has_alias_sequences) {
    L->alias_sequences = dup_array(ir->alias_sequences.data, ir->alias_sequences.len * sizeof(uint16_t));
  }
  if (ir->has_field_map) {
    TSMapSlice *slices = calloc(ir->production_id_count ? ir->production_id_count : 1, sizeof(TSMapSlice));
    uint32_t ne = ir->field_map_entries.len / 4;
    TSFieldMapEntry *entries = calloc(ne ? ne : 1, sizeof(TSFieldMapEntry));
    if (!slices || !entries) {
      MARK_FAILED(c);
      return NULL;
    }
    for (uint32_t i = 0; i < ir->production_id_count; i++) {
      slices[i].index = ir->field_map_slices.data[2 * i];
      slices[i].length = ir->field_map_slices.data[2 * i + 1];
    }
    for (uint32_t i = 0; i < ne; i++) {
      const uint8_t *e = ir->field_map_entries.data + 4 * i;
      entries[i].field_id = (uint16_t)(e[0] | (e[1] << 8));
      entries[i].child_index = e[2];
      entries[i].inherited = e[3];
    }
    L->field_map_slices = slices;
    L->field_map_entries = entries;
  }

  // Lex modes and primary states.
  if (ir->abi_version >= 15) {
    TSLexerMode *lm = calloc(N ? N : 1, sizeof(TSLexerMode));
    if (!lm) {
      MARK_FAILED(c);
      return NULL;
    }
    for (uint32_t k = 0; k < N; k++) {
      lm[k].lex_state = ir->states.data[k].lex_state;
      lm[k].external_lex_state = ir->states.data[k].ext_lex_state;
      lm[k].reserved_word_set_id = ir->states.data[k].reserved_id;
    }
    L->lex_modes = lm;
  } else {
    TSLexMode *lm = calloc(N ? N : 1, sizeof(TSLexMode));
    if (!lm) {
      MARK_FAILED(c);
      return NULL;
    }
    for (uint32_t k = 0; k < N; k++) {
      lm[k].lex_state = ir->states.data[k].lex_state;
      lm[k].external_lex_state = ir->states.data[k].ext_lex_state;
    }
    L->lex_modes = (const void *)lm;
  }
  uint16_t *primary = malloc((N ? N : 1) * sizeof(uint16_t));
  if (!primary) {
    MARK_FAILED(c);
    return NULL;
  }
  for (uint32_t k = 0; k < N; k++) primary[k] = (uint16_t)m->members.data[m->core[k]].data[0];
  L->primary_state_ids = primary;

  L->lex_fn = fns->lex_fn;
  L->keyword_lex_fn = fns->keyword_lex_fn;
  L->keyword_capture_token = (TSSymbol)ir->keyword_capture_token;
  if (ir->external_token_count) {
    L->external_scanner.states = dup_array(ir->external_states.data, ir->external_states.len);
    L->external_scanner.symbol_map = dup_array(ir->external_symbol_map.data, ir->external_token_count * sizeof(uint16_t));
  }
  L->external_scanner.create = fns->external_scanner_create;
  L->external_scanner.destroy = fns->external_scanner_destroy;
  L->external_scanner.scan = fns->external_scanner_scan;
  L->external_scanner.serialize = fns->external_scanner_serialize;
  L->external_scanner.deserialize = fns->external_scanner_deserialize;

  if (ir->abi_version >= 15) {
    if (ir->reserved_words.len) {
      L->reserved_words = dup_array(ir->reserved_words.data, ir->reserved_words.len * sizeof(uint16_t));
    }
    L->max_reserved_word_set_size = (uint16_t)ir->max_reserved_word_set_size;
    L->supertype_count = ir->supertype_count;
    if (ir->supertype_count) {
      L->supertype_symbols = dup_array(ir->supertype_symbols.data, ir->supertype_count * sizeof(uint16_t));
      TSMapSlice *slices = calloc(ir->supertype_slice_count ? ir->supertype_slice_count : 1, sizeof(TSMapSlice));
      if (!slices) {
        MARK_FAILED(c);
        return NULL;
      }
      for (uint32_t i = 0; i < ir->supertype_slice_count; i++) {
        slices[i].index = ir->supertype_map_slices.data[2 * i];
        slices[i].length = ir->supertype_map_slices.data[2 * i + 1];
      }
      L->supertype_map_slices = slices;
      L->supertype_map_entries = dup_array(ir->supertype_map_entries.data, ir->supertype_map_entries.len * sizeof(uint16_t));
    }
    L->metadata.major_version = ir->metadata[0];
    L->metadata.minor_version = ir->metadata[1];
    L->metadata.patch_version = ir->metadata[2];
  }
  return L;
}

static void codec_free(Codec *c) {
  VFREE(c->out);
  map_free(&c->bit_index);
  VFREE(c->bits);
}

static uint32_t read_u32(const uint8_t *p) {
  return (uint32_t)p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 | (uint32_t)p[3] << 24;
}

const TSLanguage *ts_packed_language_load(const uint8_t *data, size_t length, const TSPackedFunctions *functions) {
  if (length < 4 || read_u32(data) != TS_PACKED_MAGIC) return NULL;
  Codec *c = calloc(1, sizeof(Codec));
  IR *ir = calloc(1, sizeof(IR));
  PModel *m = calloc(1, sizeof(PModel));
  TSLanguage *L = NULL;
  if (c && ir && m) {
    c->enc = false;
    codec_init_fixed(c);
    c->in = data + 4;
    c->in_len = length - 4;
    rc_init(c);
    code_all(c, ir, m);
    if (!c->failed) L = render_language(c, ir, m, functions);
    if (c->failed) L = NULL;  // (allocations made so far are leaked; only on corrupt input)
    pmodel_free(m);
    ir_free(ir);
    codec_free(c);
  }
  free(c);
  free(ir);
  free(m);
  return L;
}

// ---------------------------------------------------------------------------
// Encoder (build time only)

#ifdef TS_PACKED_ENCODER

#include <stdio.h>

// Index of each token's list in ir->overlap.
static bool overlap_offsets(Codec *c, const IR *ir, U32Vec *off) {
  uint32_t pos = 0;
  for (uint32_t x = 0; x < ir->token_count; x++) {
    if (pos >= ir->overlap.len || !VPUSH(c, *off, pos)) return false;
    pos += 1 + ir->overlap.data[pos];
  }
  return pos == ir->overlap.len;
}

// tree-sitter marks a token's action list non-reusable in a state where a
// token it overlaps with is also valid. `valid[y]` is nonzero for valid tokens.
static bool predict_reusable(const IR *ir, const uint32_t *ovl_off, const uint8_t *valid, uint16_t x) {
  const uint16_t *o = ir->overlap.data + ovl_off[x];
  for (uint32_t i = 1; i <= o[0]; i++) {
    if (valid[o[i]]) return false;
  }
  return true;
}

static void rc_flush(Codec *c) {
  for (int i = 0; i < 5; i++) rc_shift_low(c);
}


static const char *g_error;
#define FAIL(msg) \
  do {            \
    g_error = (msg); \
    return false; \
  } while (0)

static uint32_t row_end(const TSLanguage *L, uint32_t s) {
  const uint16_t *base = L->small_parse_table;
  uint32_t i = L->small_parse_table_map[s];
  uint32_t groups = base[i++];
  for (uint32_t g = 0; g < groups; g++) {
    uint32_t n = base[i + 1];
    i += 2 + n;
  }
  return i;
}

static uint32_t lex_field(const TSLanguage *L, uint32_t s, int field) {
  if (L->abi_version >= 15) {
    const TSLexerMode *m = &L->lex_modes[s];
    return field == 0 ? m->lex_state : field == 1 ? m->external_lex_state : m->reserved_word_set_id;
  }
  const TSLexMode *m = &((const TSLexMode *)(const void *)L->lex_modes)[s];
  return field == 0 ? m->lex_state : field == 1 ? m->external_lex_state : 0;
}

static int red_cmp(const void *a, const void *b) {
  const RedAct *x = a, *y = b;
  if (x->symbol != y->symbol) return x->symbol < y->symbol ? -1 : 1;
  if (x->child_count != y->child_count) return x->child_count < y->child_count ? -1 : 1;
  if (x->production_id != y->production_id) return x->production_id < y->production_id ? -1 : 1;
  if (x->dynamic_precedence != y->dynamic_precedence) return x->dynamic_precedence < y->dynamic_precedence ? -1 : 1;
  return 0;
}

static uint32_t red_lookup(const IR *ir, const TSParseAction *a) {
  RedAct key = {a->reduce.symbol, a->reduce.child_count, a->reduce.dynamic_precedence, a->reduce.production_id};
  uint32_t lo = 0, hi = ir->red_acts.len;
  while (lo < hi) {
    uint32_t mid = (lo + hi) / 2;
    int cmp = red_cmp(&ir->red_acts.data[mid], &key);
    if (cmp < 0) lo = mid + 1;
    else hi = mid;
  }
  return lo < ir->red_acts.len && !red_cmp(&ir->red_acts.data[lo], &key) ? lo : NONE;
}

typedef struct {
  uint16_t x;
  uint16_t value;
} RawCell;

static int rawcell_cmp(const void *a, const void *b) {
  const RawCell *x = a, *y = b;
  return x->x < y->x ? -1 : x->x > y->x;
}

static bool extract_parse_table(Codec *c, const TSLanguage *L, IR *ir) {
  uint32_t N = L->state_count, T = L->token_count, S = L->symbol_count;
  if (L->large_state_count != 0) FAIL("large (dense) parse states are not supported; generate with TREE_SITTER_SPARSE_ONLY");
  if (!L->small_parse_table || !L->small_parse_table_map || !L->parse_actions) FAIL("missing parse table");

  // Reduce action dictionary.
  for (uint32_t s = 0; s < N; s++) {
    const uint16_t *base = L->small_parse_table;
    uint32_t i = L->small_parse_table_map[s];
    uint32_t groups = base[i++];
    for (uint32_t g = 0; g < groups; g++) {
      uint32_t value = base[i], n = base[i + 1];
      bool terminal = n && base[i + 2] < T;
      i += 2 + n;
      if (!terminal) continue;
      const TSParseActionEntry *e = &L->parse_actions[value];
      for (uint32_t a = 0; a < e->entry.count; a++) {
        const TSParseAction *act = &L->parse_actions[value + 1 + a].action;
        if (act->type == TSParseActionTypeReduce) {
          RedAct r = {act->reduce.symbol, act->reduce.child_count, act->reduce.dynamic_precedence, act->reduce.production_id};
          VPUSH(c, ir->red_acts, r);
        }
      }
    }
  }
  qsort(ir->red_acts.data, ir->red_acts.len, sizeof(RedAct), red_cmp);
  {
    uint32_t w = 0;
    for (uint32_t i = 0; i < ir->red_acts.len; i++) {
      if (w == 0 || red_cmp(&ir->red_acts.data[w - 1], &ir->red_acts.data[i])) ir->red_acts.data[w++] = ir->red_acts.data[i];
    }
    ir->red_acts.len = w;
  }
  if (ir->red_acts.len > 65535) FAIL("too many reduce actions");

  // Symbol rank: a linear extension of the order symbols appear in within groups.
  {
    Map edges = {0};
    U32Vec succ_off = {0}, succ = {0};
    uint32_t *indeg = calloc(S, sizeof(uint32_t));
    VEC(uint32_t) pairs = {0};
    for (uint32_t s = 0; s < N; s++) {
      const uint16_t *base = L->small_parse_table;
      uint32_t i = L->small_parse_table_map[s];
      uint32_t groups = base[i++];
      for (uint32_t g = 0; g < groups; g++) {
        uint32_t n = base[i + 1];
        const uint16_t *syms = base + i + 2;
        for (uint32_t j = 0; j + 1 < n; j++) {
          uint64_t key = ((uint64_t)syms[j] << 16) | syms[j + 1];
          uint32_t *slot = map_slot(c, &edges, key);
          if (*slot == UINT32_MAX) {
            *slot = 1;
            VPUSH(c, pairs, (uint32_t)key);
            indeg[syms[j + 1]]++;
          }
        }
        i += 2 + n;
      }
    }
    // adjacency via counting sort
    uint32_t *deg = calloc(S + 1, sizeof(uint32_t));
    for (uint32_t i = 0; i < pairs.len; i++) deg[(pairs.data[i] >> 16) + 1]++;
    for (uint32_t i = 0; i < S; i++) deg[i + 1] += deg[i];
    uint32_t *adj = malloc((pairs.len ? pairs.len : 1) * sizeof(uint32_t));
    uint32_t *fill = calloc(S, sizeof(uint32_t));
    for (uint32_t i = 0; i < pairs.len; i++) {
      uint32_t a = pairs.data[i] >> 16;
      adj[deg[a] + fill[a]++] = pairs.data[i] & 0xFFFF;
    }
    // Kahn's algorithm, smallest symbol first.
    uint8_t *done = calloc(S, 1);
    for (uint32_t out = 0; out < S; out++) {
      uint32_t pick = NONE;
      for (uint32_t x = 0; x < S; x++) {
        if (!done[x] && indeg[x] == 0) {
          pick = x;
          break;
        }
      }
      if (pick == NONE) {
        g_error = "symbol order within groups is cyclic";
        break;
      }
      done[pick] = 1;
      VPUSH(c, ir->rank_order, (uint16_t)pick);
      for (uint32_t j = deg[pick]; j < deg[pick + 1]; j++) indeg[adj[j]]--;
    }
    free(done);
    free(fill);
    free(adj);
    free(deg);
    free(indeg);
    VFREE(pairs);
    VFREE(succ_off);
    VFREE(succ);
    map_free(&edges);
    if (ir->rank_order.len != S) return false;
  }

  // States.
  pool_intern(c, &ir->misc_pool, NULL, 0);
  if (!VRESERVE(c, ir->states, N)) FAIL("out of memory");
  ir->states.len = N;
  VEC(RawCell) cells = {0};
  U16Vec extras = {0}, acc = {0}, rec = {0}, selfg = {0};
  VEC(Trans) nts = {0};
  // per reduce id: lookahead terminals in this state
  U32Vec red_ids = {0};
  VEC(U16Vec) red_las = {0};
  for (uint32_t s = 0; s < N && !c->failed; s++) {
    PState *st = &ir->states.data[s];
    memset(st, 0, sizeof *st);
    cells.len = extras.len = acc.len = rec.len = selfg.len = nts.len = red_ids.len = 0;
    for (uint32_t i = 0; i < red_las.len; i++) red_las.data[i].len = 0;
    const uint16_t *base = L->small_parse_table;
    uint32_t i = L->small_parse_table_map[s];
    uint32_t groups = base[i++];
    for (uint32_t g = 0; g < groups; g++) {
      uint32_t value = base[i], n = base[i + 1];
      for (uint32_t j = 0; j < n; j++) VPUSH(c, cells, ((RawCell){base[i + 2 + j], (uint16_t)value}));
      i += 2 + n;
    }
    qsort(cells.data, cells.len, sizeof(RawCell), rawcell_cmp);
    st->trans_off = ir->trans.len;
    st->ord_off = ir->ords.len;
    for (uint32_t ci = 0; ci < cells.len; ci++) {
      uint16_t x = cells.data[ci].x;
      uint32_t value = cells.data[ci].value;
      if (ci && cells.data[ci - 1].x == x) FAIL("duplicate cell");
      if (x >= T) {
        if (value == s) VPUSH(c, selfg, x);
        else VPUSH(c, nts, ((Trans){x, (uint16_t)value, 0}));
        continue;
      }
      const TSParseActionEntry *e = &L->parse_actions[value];
      uint32_t count = e->entry.count;
      if (count == 0 || count > 8) FAIL("unsupported action list length");
      // canonical keys of the actual actions
      uint32_t keys[8];
      bool shifted = false;
      for (uint32_t a = 0; a < count; a++) {
        const TSParseAction *act = &L->parse_actions[value + 1 + a].action;
        switch (act->type) {
          case TSParseActionTypeShift:
            if (act->shift.extra) {
              if (act->shift.state != 0 || act->shift.repetition) FAIL("unexpected SHIFT_EXTRA fields");
              VPUSH(c, extras, x);
              keys[a] = 4u << 20;
            } else {
              if (shifted) FAIL("two shifts in one cell");
              shifted = true;
              VPUSH(c, ir->trans, ((Trans){x, act->shift.state, act->shift.repetition}));
              keys[a] = 3u << 20;
            }
            break;
          case TSParseActionTypeReduce: {
            uint32_t r = red_lookup(ir, act);
            if (r == NONE) FAIL("reduce action missing from dictionary");
            keys[a] = r;
            uint32_t slot = 0;
            while (slot < red_ids.len && red_ids.data[slot] != r) slot++;
            if (slot == red_ids.len) {
              VPUSH(c, red_ids, r);
              while (red_las.len <= slot) VPUSH(c, red_las, ((U16Vec){0}));
              red_las.data[slot].len = 0;
            }
            U16Vec *las = &red_las.data[slot];
            if (las->len && las->data[las->len - 1] == x) FAIL("duplicate reduce in a cell");
            VPUSH(c, *las, x);
            break;
          }
          case TSParseActionTypeAccept:
            VPUSH(c, acc, x);
            keys[a] = 1u << 20;
            break;
          case TSParseActionTypeRecover:
            VPUSH(c, rec, x);
            keys[a] = 2u << 20;
            break;
          default:
            FAIL("unknown action type");
        }
        // padding bytes must be zero for the rendered table to match
        TSParseAction clean;
        memset(&clean, 0, sizeof clean);
        switch (act->type) {
          case TSParseActionTypeShift:
            clean.shift.type = act->shift.type;
            clean.shift.state = act->shift.state;
            clean.shift.extra = act->shift.extra;
            clean.shift.repetition = act->shift.repetition;
            break;
          case TSParseActionTypeReduce:
            clean.reduce.type = act->reduce.type;
            clean.reduce.child_count = act->reduce.child_count;
            clean.reduce.symbol = act->reduce.symbol;
            clean.reduce.dynamic_precedence = act->reduce.dynamic_precedence;
            clean.reduce.production_id = act->reduce.production_id;
            break;
          default:
            clean.type = act->type;
        }
        if (memcmp(&clean, act, sizeof clean)) FAIL("parse action has nonzero padding");
      }
      // canonical order check
      bool canonical = true;
      for (uint32_t a = 1; a < count; a++) {
        if (keys[a - 1] >= keys[a]) canonical = false;
      }
      if (!canonical) {
        OrderExc o = {x, (uint8_t)count, {0}};
        for (uint32_t a = 0; a < count; a++) {
          uint32_t pos = 0;
          for (uint32_t b = 0; b < count; b++) pos += keys[b] < keys[a];
          o.perm[a] = (uint8_t)pos;
        }
        VPUSH(c, ir->ords, o);
        st->ord_n++;
      }
    }
    // terminal shifts are already in ir->trans in symbol order; append gotos
    for (uint32_t t = 0; t < nts.len; t++) VPUSH(c, ir->trans, nts.data[t]);
    st->trans_n = ir->trans.len - st->trans_off;
    // reduces by id
    for (uint32_t a = 1; a < red_ids.len; a++) {
      for (uint32_t b = a; b > 0 && red_ids.data[b - 1] > red_ids.data[b]; b--) {
        uint32_t t = red_ids.data[b];
        red_ids.data[b] = red_ids.data[b - 1];
        red_ids.data[b - 1] = t;
        U16Vec tv = red_las.data[b];
        red_las.data[b] = red_las.data[b - 1];
        red_las.data[b - 1] = tv;
      }
    }
    st->red_off = ir->reds.len;
    st->red_n = red_ids.len;
    for (uint32_t a = 0; a < red_ids.len; a++) {
      uint32_t la = pool_intern(c, &ir->src_la_pool, red_las.data[a].data, red_las.data[a].len);
      VPUSH(c, ir->reds, ((Red){(uint16_t)red_ids.data[a], la}));
    }
    st->selfg = pool_intern(c, &ir->misc_pool, selfg.data, selfg.len);
    st->extras = pool_intern(c, &ir->misc_pool, extras.data, extras.len);
    st->acc = pool_intern(c, &ir->misc_pool, acc.data, acc.len);
    st->rec = pool_intern(c, &ir->misc_pool, rec.data, rec.len);
    st->lex_state = (uint16_t)lex_field(L, s, 0);
    st->ext_lex_state = (uint16_t)lex_field(L, s, 1);
    st->reserved_id = (uint16_t)lex_field(L, s, 2);
  }
  VFREE(cells);
  VFREE(extras);
  VFREE(acc);
  VFREE(rec);
  VFREE(selfg);
  VFREE(nts);
  VFREE(red_ids);
  for (uint32_t i = 0; i < red_las.len; i++) VFREE(red_las.data[i]);
  VFREE(red_las);
  if (c->failed) FAIL("out of memory");

  // Token overlap relation: for each token x, a set O(x) such that x's
  // action lists are reusable exactly in the states where no token of O(x) is
  // valid (mark_fragile_tokens in tree-sitter). Choose a small one greedily.
  {
    uint32_t words = (T + 63) / 64;
    uint64_t *valid = calloc((size_t)N * words + 1, sizeof(uint64_t));
    // per token: states where it's reusable / not
    VEC(U32Vec) reus = {0}, frag = {0};
    for (uint32_t x = 0; x < T; x++) {
      VPUSH(c, reus, ((U32Vec){0}));
      VPUSH(c, frag, ((U32Vec){0}));
    }
    if (!valid || c->failed) FAIL("out of memory");
    for (uint32_t s = 0; s < N; s++) {
      const uint16_t *base = L->small_parse_table;
      uint32_t i = L->small_parse_table_map[s];
      uint32_t groups = base[i++];
      for (uint32_t g = 0; g < groups; g++) {
        uint32_t value = base[i], n = base[i + 1];
        for (uint32_t j = 0; j < n; j++) {
          uint16_t x = base[i + 2 + j];
          if (x >= T) continue;
          valid[(size_t)s * words + x / 64] |= 1ull << (x % 64);
          U32Vec *list = L->parse_actions[value].entry.reusable ? &reus.data[x] : &frag.data[x];
          VPUSH(c, *list, s);
        }
        i += 2 + n;
      }
    }
    uint64_t *bad = malloc(words * sizeof(uint64_t));
    uint32_t *cnt = malloc(T * sizeof(uint32_t));
    U32Vec remaining = {0};
    for (uint32_t x = 0; x < T && !c->failed; x++) {
      memset(bad, 0, words * sizeof(uint64_t));
      for (uint32_t i = 0; i < reus.data[x].len; i++) {
        const uint64_t *v = valid + (size_t)reus.data[x].data[i] * words;
        for (uint32_t w = 0; w < words; w++) bad[w] |= v[w];
      }
      remaining.len = 0;
      for (uint32_t i = 0; i < frag.data[x].len; i++) VPUSH(c, remaining, frag.data[x].data[i]);
      uint32_t count_pos = ir->overlap.len;
      VPUSH(c, ir->overlap, 0);
      while (remaining.len) {
        memset(cnt, 0, T * sizeof(uint32_t));
        for (uint32_t i = 0; i < remaining.len; i++) {
          const uint64_t *v = valid + (size_t)remaining.data[i] * words;
          for (uint32_t y = 0; y < T; y++) {
            if (((v[y / 64] & ~bad[y / 64]) >> (y % 64)) & 1) cnt[y]++;
          }
        }
        uint32_t best = NONE;
        for (uint32_t y = 0; y < T; y++) {
          if (cnt[y] && (best == NONE || cnt[y] > cnt[best])) best = y;
        }
        if (best == NONE) break;  // left to per-state exceptions
        VPUSH(c, ir->overlap, (uint16_t)best);
        ir->overlap.data[count_pos]++;
        uint32_t w = 0;
        for (uint32_t i = 0; i < remaining.len; i++) {
          const uint64_t *v = valid + (size_t)remaining.data[i] * words;
          if (!((v[best / 64] >> (best % 64)) & 1)) remaining.data[w++] = remaining.data[i];
        }
        remaining.len = w;
      }
      // sort this token's list for a cheaper code later
      uint16_t *lst = ir->overlap.data + count_pos + 1;
      uint32_t n = ir->overlap.data[count_pos];
      for (uint32_t a = 1; a < n; a++) {
        for (uint32_t b = a; b > 0 && lst[b - 1] > lst[b]; b--) {
          uint16_t t = lst[b];
          lst[b] = lst[b - 1];
          lst[b - 1] = t;
        }
      }
    }
    // Per-state exceptions where the relation mispredicts.
    U32Vec ovl_off = {0};
    uint8_t *vmark = calloc(T ? T : 1, 1);
    U16Vec exc = {0};
    if (!vmark || !overlap_offsets(c, ir, &ovl_off)) FAIL("overlap relation");
    for (uint32_t s = 0; s < N && !c->failed; s++) {
      const uint64_t *v = valid + (size_t)s * words;
      for (uint32_t y = 0; y < T; y++) vmark[y] = (v[y / 64] >> (y % 64)) & 1;
      exc.len = 0;
      const uint16_t *base = L->small_parse_table;
      uint32_t i = L->small_parse_table_map[s];
      uint32_t groups = base[i++];
      for (uint32_t g = 0; g < groups; g++) {
        uint32_t value = base[i], n = base[i + 1];
        for (uint32_t j = 0; j < n; j++) {
          uint16_t x = base[i + 2 + j];
          if (x >= T) continue;
          bool actual = L->parse_actions[value].entry.reusable;
          if (predict_reusable(ir, ovl_off.data, vmark, x) != actual) VPUSH(c, exc, x);
        }
        i += 2 + n;
      }
      for (uint32_t a = 1; a < exc.len; a++) {
        for (uint32_t b = a; b > 0 && exc.data[b - 1] > exc.data[b]; b--) {
          uint16_t t = exc.data[b];
          exc.data[b] = exc.data[b - 1];
          exc.data[b - 1] = t;
        }
      }
      ir->states.data[s].reus_exc = pool_intern(c, &ir->misc_pool, exc.data, exc.len);
    }
    VFREE(ovl_off);
    VFREE(exc);
    free(vmark);
    free(bad);
    free(cnt);
    VFREE(remaining);
    for (uint32_t x = 0; x < T; x++) {
      VFREE(reus.data[x]);
      VFREE(frag.data[x]);
    }
    VFREE(reus);
    VFREE(frag);
    free(valid);
    if (g_error) return false;
  }
  return !c->failed;
}

static bool extract(Codec *c, const TSLanguage *L, IR *ir) {
  ir->abi_version = L->abi_version;
  ir->symbol_count = L->symbol_count;
  ir->alias_count = L->alias_count;
  ir->token_count = L->token_count;
  ir->external_token_count = L->external_token_count;
  ir->state_count = L->state_count;
  ir->production_id_count = L->production_id_count;
  ir->field_count = L->field_count;
  ir->max_alias_sequence_length = L->max_alias_sequence_length;
  ir->keyword_capture_token = L->keyword_capture_token;
  ir->has_keyword_lex = L->keyword_lex_fn != NULL;
  ir->has_external_scanner = L->external_scanner.create != NULL;
  ir->has_field_map = L->field_map_slices != NULL;
  ir->has_alias_sequences = L->alias_sequences != NULL;
  ir->has_alias_map = L->alias_map != NULL;
  ir->enc_primary = L->primary_state_ids;
  if (!L->primary_state_ids) FAIL("missing primary_state_ids (ABI < 14)");
  if (L->abi_version >= 15) {
    ir->max_reserved_word_set_size = L->max_reserved_word_set_size;
    ir->supertype_count = L->supertype_count;
    ir->metadata[0] = L->metadata.major_version;
    ir->metadata[1] = L->metadata.minor_version;
    ir->metadata[2] = L->metadata.patch_version;
    ir->has_name = L->name != NULL;
  }
  uint32_t nsym = L->symbol_count + L->alias_count;
  for (uint32_t i = 0; i < nsym; i++) {
    const char *s = L->symbol_names[i];
    size_t n = strlen(s) + 1;
    for (size_t j = 0; j < n; j++) VPUSH(c, ir->strings, (uint8_t)s[j]);
  }
  for (uint32_t i = 1; i <= L->field_count; i++) {
    const char *s = L->field_names[i];
    size_t n = strlen(s) + 1;
    for (size_t j = 0; j < n; j++) VPUSH(c, ir->strings, (uint8_t)s[j]);
  }
  if (ir->has_name) {
    size_t n = strlen(L->name) + 1;
    for (size_t j = 0; j < n; j++) VPUSH(c, ir->strings, (uint8_t)L->name[j]);
  }
  for (uint32_t i = 0; i < nsym; i++) {
    VPUSH(c, ir->symbol_metadata, L->symbol_metadata[i].visible);
    VPUSH(c, ir->symbol_metadata, L->symbol_metadata[i].named);
    VPUSH(c, ir->symbol_metadata, L->symbol_metadata[i].supertype);
    VPUSH(c, ir->public_symbol_map, L->public_symbol_map[i]);
  }
  if (L->alias_map) {
    uint32_t idx = 0;
    for (;;) {
      uint16_t sym = L->alias_map[idx++];
      VPUSH(c, ir->alias_map, sym);
      if (sym == 0) break;
      uint16_t n = L->alias_map[idx++];
      VPUSH(c, ir->alias_map, n);
      for (uint16_t j = 0; j < n; j++) VPUSH(c, ir->alias_map, L->alias_map[idx++]);
    }
  }
  if (L->alias_sequences) {
    for (uint32_t i = 0; i < L->production_id_count * L->max_alias_sequence_length; i++) {
      VPUSH(c, ir->alias_sequences, L->alias_sequences[i]);
    }
  }
  if (L->field_map_slices) {
    uint32_t ne = 0;
    for (uint32_t i = 0; i < L->production_id_count; i++) {
      VPUSH(c, ir->field_map_slices, L->field_map_slices[i].index);
      VPUSH(c, ir->field_map_slices, L->field_map_slices[i].length);
      uint32_t end = (uint32_t)L->field_map_slices[i].index + L->field_map_slices[i].length;
      if (end > ne) ne = end;
    }
    for (uint32_t i = 0; i < ne; i++) {
      const TSFieldMapEntry *e = &L->field_map_entries[i];
      VPUSH(c, ir->field_map_entries, (uint8_t)e->field_id);
      VPUSH(c, ir->field_map_entries, (uint8_t)(e->field_id >> 8));
      VPUSH(c, ir->field_map_entries, e->child_index);
      VPUSH(c, ir->field_map_entries, e->inherited);
    }
  }
  uint32_t max_ext = 0, max_res = 0;
  for (uint32_t s = 0; s < L->state_count; s++) {
    if (lex_field(L, s, 1) > max_ext) max_ext = lex_field(L, s, 1);
    if (lex_field(L, s, 2) > max_res) max_res = lex_field(L, s, 2);
  }
  if (L->external_token_count) {
    for (uint32_t i = 0; i < L->external_token_count; i++) VPUSH(c, ir->external_symbol_map, L->external_scanner.symbol_map[i]);
    ir->ext_state_count = max_ext + 1;
    for (uint32_t i = 0; i < ir->ext_state_count * L->external_token_count; i++) {
      VPUSH(c, ir->external_states, L->external_scanner.states[i]);
    }
  }
  if (L->abi_version >= 15) {
    if (L->reserved_words) {
      ir->reserved_set_count = max_res + 1;
      for (uint32_t i = 0; i < ir->reserved_set_count * L->max_reserved_word_set_size; i++) {
        VPUSH(c, ir->reserved_words, L->reserved_words[i]);
      }
    }
    if (L->supertype_count) {
      uint32_t max_sym = 0, ne = 0;
      for (uint32_t i = 0; i < L->supertype_count; i++) {
        VPUSH(c, ir->supertype_symbols, L->supertype_symbols[i]);
        if (L->supertype_symbols[i] > max_sym) max_sym = L->supertype_symbols[i];
      }
      ir->supertype_slice_count = max_sym + 1;
      for (uint32_t i = 0; i < ir->supertype_slice_count; i++) {
        VPUSH(c, ir->supertype_map_slices, L->supertype_map_slices[i].index);
        VPUSH(c, ir->supertype_map_slices, L->supertype_map_slices[i].length);
        uint32_t end = (uint32_t)L->supertype_map_slices[i].index + L->supertype_map_slices[i].length;
        if (end > ne) ne = end;
      }
      for (uint32_t i = 0; i < ne; i++) VPUSH(c, ir->supertype_map_entries, L->supertype_map_entries[i]);
    }
  }
  return extract_parse_table(c, L, ir);
}

uint8_t *ts_packed_encode(const TSLanguage *L, size_t *length, const char **error) {
  static Codec c;
  memset(&c, 0, sizeof c);
  c.enc = true;
  codec_init_fixed(&c);
  static IR ir;
  memset(&ir, 0, sizeof ir);
  static PModel m;
  memset(&m, 0, sizeof m);
  g_error = NULL;
  uint8_t *result = NULL;
  if (!extract(&c, L, &ir)) goto done;
  for (int i = 0; i < 4; i++) VPUSH(&c, c.out, (uint8_t)(TS_PACKED_MAGIC >> (8 * i)));
  rc_init(&c);
  code_all(&c, &ir, &m);
  rc_flush(&c);
  if (c.failed) {
    if (!g_error) g_error = "encoding failed";
    goto done;
  }
  result = c.out.data;
  *length = c.out.len;
  c.out.data = NULL;
done:
  if (error) *error = g_error ? g_error : (c.failed ? "out of memory" : NULL);
  pmodel_free(&m);
  ir_free(&ir);
  codec_free(&c);
  return result;
}

// Compare a decoded language against the original, table by table.
bool ts_packed_verify(const TSLanguage *L, const uint8_t *blob, size_t length, const char **error) {
  TSPackedFunctions fns = {
    L->lex_fn,
    L->keyword_lex_fn,
    L->external_scanner.create,
    L->external_scanner.destroy,
    L->external_scanner.scan,
    L->external_scanner.serialize,
    L->external_scanner.deserialize,
  };
  const TSLanguage *D = ts_packed_language_load(blob, length, &fns);
  *error = NULL;
#define CHECK(cond, what) \
  if (!(cond)) {          \
    *error = (what);      \
    return false;         \
  }
  CHECK(D != NULL, "decoding failed");
  CHECK(D->abi_version == L->abi_version && D->symbol_count == L->symbol_count && D->alias_count == L->alias_count &&
          D->token_count == L->token_count && D->external_token_count == L->external_token_count &&
          D->state_count == L->state_count && D->large_state_count == L->large_state_count &&
          D->production_id_count == L->production_id_count && D->field_count == L->field_count &&
          D->max_alias_sequence_length == L->max_alias_sequence_length &&
          D->keyword_capture_token == L->keyword_capture_token,
        "header");
  uint32_t N = L->state_count, nsym = L->symbol_count + L->alias_count;
  uint32_t spt_len = 0, pa_len = 1;
  for (uint32_t s = 0; s < N; s++) {
    uint32_t e = row_end(L, s);
    if (e > spt_len) spt_len = e;
    const uint16_t *base = L->small_parse_table;
    uint32_t i = L->small_parse_table_map[s];
    uint32_t groups = base[i++];
    for (uint32_t g = 0; g < groups; g++) {
      uint32_t value = base[i], n = base[i + 1];
      if (n && base[i + 2] < L->token_count) {
        uint32_t end = value + 1 + L->parse_actions[value].entry.count;
        if (end > pa_len) pa_len = end;
      }
      i += 2 + n;
    }
  }
  uint32_t dspt_len = 0;
  for (uint32_t s = 0; s < N; s++) {
    uint32_t e = row_end(D, s);
    if (e > dspt_len) dspt_len = e;
  }
  CHECK(dspt_len == spt_len, "small_parse_table length");
  CHECK(!memcmp(D->small_parse_table, L->small_parse_table, spt_len * sizeof(uint16_t)), "small_parse_table");
  CHECK(!memcmp(D->small_parse_table_map, L->small_parse_table_map, N * sizeof(uint32_t)), "small_parse_table_map");
  CHECK(!memcmp(D->parse_actions, L->parse_actions, pa_len * sizeof(TSParseActionEntry)), "parse_actions");
  for (uint32_t i = 0; i < nsym; i++) CHECK(!strcmp(D->symbol_names[i], L->symbol_names[i]), "symbol_names");
  for (uint32_t i = 1; i <= L->field_count; i++) CHECK(!strcmp(D->field_names[i], L->field_names[i]), "field_names");
  CHECK(D->field_names[0] == NULL || L->field_names == NULL || L->field_names[0] == NULL, "field_names[0]");
  CHECK(!memcmp(D->symbol_metadata, L->symbol_metadata, nsym * sizeof(TSSymbolMetadata)), "symbol_metadata");
  CHECK(!memcmp(D->public_symbol_map, L->public_symbol_map, nsym * sizeof(TSSymbol)), "public_symbol_map");
  CHECK((D->alias_map == NULL) == (L->alias_map == NULL), "alias_map presence");
  if (L->alias_map) {
    uint32_t idx = 0;
    for (;;) {
      CHECK(D->alias_map[idx] == L->alias_map[idx], "alias_map");
      if (L->alias_map[idx++] == 0) break;
      uint16_t n = L->alias_map[idx];
      CHECK(D->alias_map[idx] == n, "alias_map");
      idx++;
      for (uint16_t j = 0; j < n; j++, idx++) CHECK(D->alias_map[idx] == L->alias_map[idx], "alias_map");
    }
  }
  CHECK((D->alias_sequences == NULL) == (L->alias_sequences == NULL), "alias_sequences presence");
  if (L->alias_sequences) {
    CHECK(!memcmp(D->alias_sequences, L->alias_sequences, L->production_id_count * L->max_alias_sequence_length * sizeof(TSSymbol)), "alias_sequences");
  }
  CHECK((D->field_map_slices == NULL) == (L->field_map_slices == NULL), "field map presence");
  if (L->field_map_slices) {
    uint32_t ne = 0;
    for (uint32_t i = 0; i < L->production_id_count; i++) {
      uint32_t end = (uint32_t)L->field_map_slices[i].index + L->field_map_slices[i].length;
      if (end > ne) ne = end;
    }
    CHECK(!memcmp(D->field_map_slices, L->field_map_slices, L->production_id_count * sizeof(TSMapSlice)), "field_map_slices");
    for (uint32_t i = 0; i < ne; i++) {
      CHECK(D->field_map_entries[i].field_id == L->field_map_entries[i].field_id &&
              D->field_map_entries[i].child_index == L->field_map_entries[i].child_index &&
              D->field_map_entries[i].inherited == L->field_map_entries[i].inherited,
            "field_map_entries");
    }
  }
  for (uint32_t s = 0; s < N; s++) {
    for (int f = 0; f < 3; f++) CHECK(lex_field(D, s, f) == lex_field(L, s, f), "lex_modes");
  }
  CHECK(!memcmp(D->primary_state_ids, L->primary_state_ids, N * sizeof(TSStateId)), "primary_state_ids");
  CHECK(D->lex_fn == L->lex_fn && D->keyword_lex_fn == L->keyword_lex_fn, "lex functions");
  CHECK(!memcmp(&D->external_scanner.create, &L->external_scanner.create, 5 * sizeof(void *)), "scanner functions");
  if (L->external_token_count) {
    uint32_t max_ext = 0;
    for (uint32_t s = 0; s < N; s++) {
      if (lex_field(L, s, 1) > max_ext) max_ext = lex_field(L, s, 1);
    }
    CHECK(!memcmp(D->external_scanner.symbol_map, L->external_scanner.symbol_map, L->external_token_count * sizeof(TSSymbol)), "external symbol map");
    CHECK(!memcmp(D->external_scanner.states, L->external_scanner.states, (max_ext + 1) * L->external_token_count), "external states");
  }
  if (L->abi_version >= 15) {
    CHECK(D->max_reserved_word_set_size == L->max_reserved_word_set_size && D->supertype_count == L->supertype_count, "abi15 header");
    CHECK(!memcmp(&D->metadata, &L->metadata, sizeof(TSLanguageMetadata)), "metadata");
    CHECK((D->name == NULL) == (L->name == NULL) && (!L->name || !strcmp(D->name, L->name)), "name");
    if (L->reserved_words) {
      uint32_t max_res = 0;
      for (uint32_t s = 0; s < N; s++) {
        if (lex_field(L, s, 2) > max_res) max_res = lex_field(L, s, 2);
      }
      CHECK(!memcmp(D->reserved_words, L->reserved_words, (max_res + 1) * L->max_reserved_word_set_size * sizeof(TSSymbol)), "reserved_words");
    }
    if (L->supertype_count) {
      CHECK(!memcmp(D->supertype_symbols, L->supertype_symbols, L->supertype_count * sizeof(TSSymbol)), "supertype_symbols");
      uint32_t max_sym = 0, ne = 0;
      for (uint32_t i = 0; i < L->supertype_count; i++) {
        if (L->supertype_symbols[i] > max_sym) max_sym = L->supertype_symbols[i];
      }
      for (uint32_t i = 0; i <= max_sym; i++) {
        CHECK(D->supertype_map_slices[i].index == L->supertype_map_slices[i].index &&
                D->supertype_map_slices[i].length == L->supertype_map_slices[i].length,
              "supertype_map_slices");
        uint32_t end = (uint32_t)L->supertype_map_slices[i].index + L->supertype_map_slices[i].length;
        if (end > ne) ne = end;
      }
      CHECK(!memcmp(D->supertype_map_entries, L->supertype_map_entries, ne * sizeof(TSSymbol)), "supertype_map_entries");
    }
  }
#undef CHECK
  return true;
}

#endif  // TS_PACKED_ENCODER
