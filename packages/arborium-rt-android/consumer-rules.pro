# Keep the JNI binding class and its native method names so the runtime linker
# can resolve them against libarborium_rt.so after R8/ProGuard shrinking in the
# consuming app.
-keep class com.discord.arborium.ArboriumNative { *; }
-keepclasseswithmembernames class com.discord.arborium.** {
    native <methods>;
}
