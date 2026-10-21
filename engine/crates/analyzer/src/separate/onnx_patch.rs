const MODEL_GRAPH: u32 = 7;
const GRAPH_NODE: u32 = 1;
const NODE_OP_TYPE: u32 = 4;
const NODE_ATTRIBUTE: u32 = 5;
const ATTR_NAME: u32 = 1;
const ATTR_INTS: u32 = 8;

const WIRE_VARINT: u8 = 0;
const WIRE_I64: u8 = 1;
pub(crate) const WIRE_LEN: u8 = 2;
const WIRE_I32: u8 = 5;

pub(crate) struct Field<'a> {
    pub num: u32,
    pub wire: u8,
    pub raw: &'a [u8],
    pub payload: &'a [u8],
}

fn read_varint(buf: &[u8], pos: &mut usize) -> Result<u64, String> {
    let mut v: u64 = 0;
    for shift in (0..64).step_by(7) {
        let b = *buf.get(*pos).ok_or("truncated varint")?;
        *pos += 1;
        v |= u64::from(b & 0x7f) << shift;
        if b & 0x80 == 0 {
            return Ok(v);
        }
    }
    Err("varint too long".into())
}

fn write_varint(out: &mut Vec<u8>, mut v: u64) {
    loop {
        let b = (v & 0x7f) as u8;
        v >>= 7;
        if v == 0 {
            out.push(b);
            return;
        }
        out.push(b | 0x80);
    }
}

pub(crate) fn parse(buf: &[u8]) -> Result<Vec<Field<'_>>, String> {
    let mut fields = Vec::new();
    let mut pos = 0;
    while pos < buf.len() {
        let start = pos;
        let tag = read_varint(buf, &mut pos)?;
        let num = (tag >> 3) as u32;
        let wire = (tag & 7) as u8;
        let payload_start;
        match wire {
            WIRE_VARINT => {
                payload_start = pos;
                read_varint(buf, &mut pos)?;
            }
            WIRE_I64 => {
                payload_start = pos;
                pos += 8;
            }
            WIRE_LEN => {
                let len = read_varint(buf, &mut pos)? as usize;
                payload_start = pos;
                pos = pos.checked_add(len).ok_or("length overflow")?;
            }
            WIRE_I32 => {
                payload_start = pos;
                pos += 4;
            }
            w => return Err(format!("unsupported protobuf wire type {w}")),
        }
        if pos > buf.len() {
            return Err("truncated field".into());
        }
        fields.push(Field { num, wire, raw: &buf[start..pos], payload: &buf[payload_start..pos] });
    }
    Ok(fields)
}

pub(crate) fn write_len_field(out: &mut Vec<u8>, num: u32, payload: &[u8]) {
    write_varint(out, (u64::from(num) << 3) | u64::from(WIRE_LEN));
    write_varint(out, payload.len() as u64);
    out.extend_from_slice(payload);
}

fn is_zero_output_padding(attr: &[u8]) -> Result<bool, String> {
    let mut name_ok = false;
    let mut all_zero = true;
    for f in parse(attr)? {
        match (f.num, f.wire) {
            (ATTR_NAME, WIRE_LEN) => name_ok = f.payload == b"output_padding",
            (ATTR_INTS, WIRE_LEN) => {
                let mut p = 0;
                while p < f.payload.len() {
                    if read_varint(f.payload, &mut p)? != 0 {
                        all_zero = false;
                    }
                }
            }
            (ATTR_INTS, WIRE_VARINT) => {
                let mut p = 0;
                if read_varint(f.payload, &mut p)? != 0 {
                    all_zero = false;
                }
            }
            _ => {}
        }
    }
    Ok(name_ok && all_zero)
}

fn rewrite_node(node: &[u8], removed: &mut usize) -> Result<Option<Vec<u8>>, String> {
    let fields = parse(node)?;
    let is_conv_t = fields.iter().any(|f| f.num == NODE_OP_TYPE && f.wire == WIRE_LEN && f.payload == b"ConvTranspose");
    if !is_conv_t {
        return Ok(None);
    }
    let mut out = Vec::with_capacity(node.len());
    let mut changed = false;
    for f in &fields {
        if f.num == NODE_ATTRIBUTE && f.wire == WIRE_LEN && is_zero_output_padding(f.payload)? {
            changed = true;
            *removed += 1;
            continue;
        }
        out.extend_from_slice(f.raw);
    }
    Ok(changed.then_some(out))
}

fn rewrite_graph(graph: &[u8], removed: &mut usize) -> Result<Option<Vec<u8>>, String> {
    let mut out = Vec::with_capacity(graph.len());
    let mut changed = false;
    for f in parse(graph)? {
        if f.num == GRAPH_NODE && f.wire == WIRE_LEN {
            if let Some(node) = rewrite_node(f.payload, removed)? {
                write_len_field(&mut out, GRAPH_NODE, &node);
                changed = true;
                continue;
            }
        }
        out.extend_from_slice(f.raw);
    }
    Ok(changed.then_some(out))
}

pub fn strip_zero_output_padding(model: &[u8]) -> Result<(Vec<u8>, usize), String> {
    let mut removed = 0;
    let mut out = Vec::with_capacity(model.len());
    for f in parse(model)? {
        if f.num == MODEL_GRAPH && f.wire == WIRE_LEN {
            if let Some(graph) = rewrite_graph(f.payload, &mut removed)? {
                write_len_field(&mut out, MODEL_GRAPH, &graph);
                continue;
            }
        }
        out.extend_from_slice(f.raw);
    }
    Ok((out, removed))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn str_field(num: u32, s: &str) -> Vec<u8> {
        let mut v = Vec::new();
        write_len_field(&mut v, num, s.as_bytes());
        v
    }

    fn ints_attr(name: &str, ints: &[u64], packed: bool) -> Vec<u8> {
        let mut a = str_field(ATTR_NAME, name);
        if packed {
            let mut p = Vec::new();
            for &i in ints {
                write_varint(&mut p, i);
            }
            write_len_field(&mut a, ATTR_INTS, &p);
        } else {
            for &i in ints {
                write_varint(&mut a, (u64::from(ATTR_INTS) << 3) | u64::from(WIRE_VARINT));
                write_varint(&mut a, i);
            }
        }
        write_varint(&mut a, (20 << 3) | u64::from(WIRE_VARINT));
        write_varint(&mut a, 7);
        a
    }

    fn node(op: &str, attrs: &[Vec<u8>]) -> Vec<u8> {
        let mut n = str_field(1, "in");
        n.extend(str_field(2, "out"));
        n.extend(str_field(NODE_OP_TYPE, op));
        for a in attrs {
            write_len_field(&mut n, NODE_ATTRIBUTE, a);
        }
        n
    }

    fn model(nodes: &[Vec<u8>]) -> Vec<u8> {
        let mut g = Vec::new();
        for n in nodes {
            write_len_field(&mut g, GRAPH_NODE, n);
        }
        g.extend(str_field(2, "graph-name"));
        let mut m = Vec::new();
        write_varint(&mut m, (1 << 3) | u64::from(WIRE_VARINT));
        write_varint(&mut m, 10);
        write_len_field(&mut m, MODEL_GRAPH, &g);
        m.extend(str_field(2, "pytorch"));
        m
    }

    #[test]
    fn removes_only_zero_output_padding_on_conv_transpose() {
        let strides = ints_attr("strides", &[4], true);
        let n1 = node("ConvTranspose", &[ints_attr("output_padding", &[0], true), strides.clone()]);
        let n2 = node("ConvTranspose", &[ints_attr("output_padding", &[0, 0], false)]);
        let keep_nonzero = node("ConvTranspose", &[ints_attr("output_padding", &[1], true)]);
        let other_op = node("Conv", &[ints_attr("output_padding", &[0], true)]);
        let m = model(&[n1, n2, keep_nonzero.clone(), other_op.clone()]);
        let (patched, removed) = strip_zero_output_padding(&m).unwrap();
        assert_eq!(removed, 2);
        let expected = model(&[node("ConvTranspose", &[strides]), node("ConvTranspose", &[]), keep_nonzero, other_op]);
        assert_eq!(patched, expected);
    }

    #[test]
    fn untouched_model_is_identical() {
        let m = model(&[node("Conv", &[ints_attr("strides", &[1, 1], true)])]);
        let (patched, removed) = strip_zero_output_padding(&m).unwrap();
        assert_eq!(removed, 0);
        assert_eq!(patched, m);
    }

    #[test]
    fn rejects_garbage() {
        assert!(strip_zero_output_padding(&[0x3a, 0xff, 0xff, 0xff]).is_err());
    }
}
