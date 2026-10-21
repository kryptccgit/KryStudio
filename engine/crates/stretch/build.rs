fn main() {
    println!("cargo:rerun-if-changed=shim/kss.cpp");
    println!("cargo:rerun-if-changed=vendor/signalsmith-stretch/signalsmith-stretch.h");
    println!("cargo:rerun-if-changed=vendor/signalsmith-linear/fft.h");
    println!("cargo:rerun-if-changed=vendor/signalsmith-linear/stft.h");
    println!("cargo:rerun-if-env-changed=KRYPT_CHECK_ONLY");
    if std::env::var_os("KRYPT_CHECK_ONLY").is_some() {
        return;
    }

    let mut b = cc::Build::new();
    b.cpp(true)
        .file("shim/kss.cpp")
        .include("vendor")
        .opt_level(2)
        .define("NDEBUG", None)
        .warnings(false);
    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
        b.flag("/std:c++14").flag("/EHsc").flag("/fp:precise");
    } else {
        b.flag("-std=c++14");
    }
    b.compile("kss_signalsmith_stretch");
}
