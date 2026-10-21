use serde::Serializer;

#[inline]
pub(crate) fn widen(x: f32) -> f64 {
    if !x.is_finite() {
        return f64::NAN;
    }
    format!("{x}").parse::<f64>().unwrap_or(x as f64)
}

pub(crate) fn f32<S: Serializer>(x: &f32, s: S) -> Result<S::Ok, S::Error> {
    let v = widen(*x);
    if v.is_finite() {
        s.serialize_f64(v)
    } else {
        s.serialize_none()
    }
}

pub(crate) fn opt_f32<S: Serializer>(x: &Option<f32>, s: S) -> Result<S::Ok, S::Error> {
    match x.map(widen) {
        Some(v) if v.is_finite() => s.serialize_some(&v),
        _ => s.serialize_none(),
    }
}

pub(crate) fn vec_f32<S: Serializer>(x: &[f32], s: S) -> Result<S::Ok, S::Error> {
    use serde::ser::SerializeSeq;
    let mut seq = s.serialize_seq(Some(x.len()))?;
    for v in x {
        let w = widen(*v);
        if w.is_finite() {
            seq.serialize_element(&w)?;
        } else {
            seq.serialize_element(&Option::<f64>::None)?;
        }
    }
    seq.end()
}
