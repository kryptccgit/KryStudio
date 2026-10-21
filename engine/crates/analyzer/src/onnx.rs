use std::collections::HashMap;
use std::path::Path;

use rten::{Model, ModelOptions, NodeId, ValueView};
use rten_tensor::Layout;

use crate::{JobCtx, JobError};

pub type Outputs = HashMap<String, (Vec<usize>, Vec<f32>)>;

pub struct RtenModel {
    model: Model,
    inputs: HashMap<String, NodeId>,
    outputs: Vec<(NodeId, String)>,
    label: String,
    ctx: Option<JobCtx>,
    on_run: Option<Box<dyn FnMut(usize) + Send>>,
    runs: usize,
}

impl RtenModel {
    pub fn load(path: &Path, label: &str) -> Result<Self, JobError> {
        if !path.is_file() {
            let dir = path.parent().map(|p| p.display().to_string()).unwrap_or_default();
            let file = path.file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or_default();
            return Err(JobError::Failed(format!("{label} model not found in {dir} ({file})")));
        }
        let model = ModelOptions::with_all_ops().load_file(path).map_err(|e| JobError::Failed(format!("Cannot load the {label} model {}: {e}", path.display())))?;
        let inputs = model
            .input_ids()
            .iter()
            .filter_map(|&id| Some((model.node_info(id)?.name()?.to_string(), id)))
            .collect();
        let outputs = model.output_ids().iter().filter_map(|&id| Some((id, model.node_info(id)?.name()?.to_string()))).collect();
        Ok(Self { model, inputs, outputs, label: label.to_string(), ctx: None, on_run: None, runs: 0 })
    }

    pub fn with_ctx(mut self, ctx: &JobCtx) -> Self {
        self.ctx = Some(ctx.clone());
        self
    }

    pub fn on_run(mut self, f: impl FnMut(usize) + Send + 'static) -> Self {
        self.on_run = Some(Box::new(f));
        self
    }

    pub fn output_names(&self) -> Vec<String> {
        self.outputs.iter().map(|o| o.1.clone()).collect()
    }

    pub fn run_named(&mut self, inputs: &[(&str, &[usize], &[f32])]) -> Result<Outputs, JobError> {
        if let Some(ctx) = &self.ctx {
            ctx.check()?;
        }
        if let Some(f) = self.on_run.as_mut() {
            f(self.runs);
        }
        self.runs += 1;
        let mut ins = Vec::with_capacity(inputs.len());
        for (name, shape, data) in inputs {
            let id = *self.inputs.get(*name).ok_or_else(|| JobError::Failed(format!("The {} model has no input named '{name}'", self.label)))?;
            let view = ValueView::from_shape(*shape, data).map_err(|e| JobError::Failed(format!("Bad input for the {} model: {e}", self.label)))?;
            ins.push((id, view.into()));
        }
        let ids: Vec<NodeId> = self.outputs.iter().map(|o| o.0).collect();
        let outs = self.model.run(ins, &ids, None).map_err(|e| JobError::Failed(format!("The {} model failed to run: {e}", self.label)))?;
        let mut r = HashMap::new();
        for ((_, name), v) in self.outputs.iter().zip(outs) {
            let t = v.into_tensor::<f32>().ok_or_else(|| JobError::Failed(format!("The {} model returned a non-float output '{name}'", self.label)))?;
            r.insert(name.clone(), (t.shape().to_vec(), t.into_data()));
        }
        Ok(r)
    }
}

#[derive(Debug)]
pub struct CancelledInModel;

impl std::fmt::Display for CancelledInModel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("cancelled")
    }
}

impl std::error::Error for CancelledInModel {}

impl beat_this::Model for RtenModel {
    fn run(&mut self, inputs: &[(&str, &beat_this::Tensor)]) -> anyhow::Result<HashMap<String, beat_this::Tensor>> {
        let ins: Vec<(&str, &[usize], &[f32])> = inputs.iter().map(|(n, t)| (*n, t.shape.as_slice(), t.data.as_slice())).collect();
        match self.run_named(&ins) {
            Ok(m) => Ok(m.into_iter().map(|(k, (shape, data))| (k, beat_this::Tensor { shape, data })).collect()),
            Err(JobError::Cancelled) => Err(anyhow::Error::new(CancelledInModel)),
            Err(JobError::Failed(m)) => Err(anyhow::anyhow!(m)),
        }
    }
}
