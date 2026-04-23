# @discord/arborium-rt-plugin-rspack

Optional rspack plugin for [`@discord/arborium-rt`](../arborium-rt/).
Filters the bundled `GRAMMARS` map down to a user-supplied allow/deny
list at build time, so rspack only emits the grammar `.wasm` / `.scm`
assets you actually use.

Without this plugin, the runtime's single-object design causes rspack to
statically trace every language's URLs — producing ~160 MB of emitted
assets per build. With an allow list of three languages that drops to
around 5 MB.

## Install

```sh
npm install --save-dev @discord/arborium-rt-plugin-rspack
```

Peer deps: `@discord/arborium-rt` and `@rspack/core` (>= 1.0).

## Usage

```ts
// rspack.config.ts
import { ArboriumRtRspackPlugin } from '@discord/arborium-rt-plugin-rspack';

export default {
    plugins: [
        new ArboriumRtRspackPlugin({
            allow: ['json', 'rust', 'typescript'],
        }),
    ],
};
```

Under rsbuild:

```ts
// rsbuild.config.ts
import { defineConfig } from '@rsbuild/core';
import { ArboriumRtRspackPlugin } from '@discord/arborium-rt-plugin-rspack';

export default defineConfig({
    tools: {
        rspack: {
            plugins: [
                new ArboriumRtRspackPlugin({ deny: ['groovy', 'svelte'] }),
            ],
        },
    },
});
```

## Options

```ts
interface ArboriumRtRspackPluginOptions {
    allow?: readonly string[];
    deny?: readonly string[];
}
```

- **`allow`** — if present, any language id NOT in this list is stripped.
- **`deny`** — removes listed ids. Applied after `allow`, so ids that appear
  in both lists end up denied.
- Unknown ids are silently ignored — typos just don't contribute anything.
- No options → no-op (`new ArboriumRtRspackPlugin()` changes nothing).

## How it works

The plugin registers a loader scoped to
`@discord/arborium-rt/dist/grammars.js`. The loader takes the module's
source (a single `export const GRAMMARS = { … }` literal whose shape is
controlled by the runtime's code generator) and deletes entry blocks
for language ids that fail the filter. Rspack parses the rewritten
source, never sees the stripped URLs, and never emits those assets.

The runtime code doesn't need any awareness of the plugin.

## License

MIT.
