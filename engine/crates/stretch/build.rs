//! Compiles the vendored, header-only Signalsmith Stretch (MIT) behind a tiny
//! C shim. No bindgen / libclang: the Rust side declares the 12 extern fns
//! by hand. The static CRT from the repo-root .cargo/config.toml is honoured
//! by `cc` (it reads the `crt-static` target feature and uses /MT).

fn main() {
    println!("cargo:rerun-if-changed=shim/kss.cpp");
    println!("cargo:rerun-if-changed=vendor/signalsmith-stretch/signalsmith-stretch.h");
    println!("cargo:rerun-if-changed=vendor/signalsmith-linear/fft.h");
    println!("cargo:rerun-if-changed=vendor/signalsmith-linear/stft.h");
    println!("cargo:rerun-if-env-changed=KRYPT_CHECK_ONLY");
    // `cargo check` for another OS (scripts/check-targets.mjs) never links, and the host can't compile C++ for it.
    if std::env::var_os("KRYPT_CHECK_ONLY").is_some() {
        return;
    }

    let mut b = cc::Build::new();
    b.cpp(true)
        .file("shim/kss.cpp")
        .include("vendor")
        // The stretcher is pure number crunching and ~10x slower unoptimized:
        // always optimize it, even in debug / test builds.
        .opt_level(2)
        .define("NDEBUG", None)
        // Third-party header: keep everyone's build output clean.
        .warnings(false);
    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
        b.flag("/std:c++14").flag("/EHsc").flag("/fp:precise");
    } else {
        b.flag("-std=c++14");
    }
    b.compile("kss_signalsmith_stretch");
}
