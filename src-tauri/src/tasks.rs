use serde::Serialize;
use std::sync::Mutex;
use std::time::Instant;
use tauri::{AppHandle, Emitter};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TaskEvent {
    pub id: String,
    pub title: String,
    pub detail: String,
    /// 0..1, or -1 when indeterminate.
    pub progress: f64,
    pub state: String,
}

/// A long-running job surfaced in the UI's task tray.
pub struct Task {
    app: AppHandle,
    id: String,
    title: String,
    last: Mutex<Option<Instant>>,
}

impl Task {
    pub fn new(app: &AppHandle, title: impl Into<String>) -> Self {
        let t = Task { app: app.clone(), id: uuid::Uuid::new_v4().to_string(), title: title.into(), last: Mutex::new(None) };
        t.send("Starting…", -1.0, "running");
        t
    }

    fn send(&self, detail: &str, progress: f64, state: &str) {
        let _ = self.app.emit(
            "task",
            TaskEvent { id: self.id.clone(), title: self.title.clone(), detail: detail.to_string(), progress, state: state.to_string() },
        );
    }

    pub fn step(&self, detail: &str) {
        self.send(detail, -1.0, "running");
    }

    pub fn progress(&self, label: &str, done: usize, total: usize) {
        {
            let mut last = self.last.lock().unwrap();
            if done < total {
                if let Some(t) = *last {
                    if t.elapsed().as_millis() < 90 {
                        return;
                    }
                }
            }
            *last = Some(Instant::now());
        }
        let p = if total == 0 { 1.0 } else { done as f64 / total as f64 };
        self.send(&format!("{label} · {done}/{total}"), p, "running");
    }

    pub fn done(&self, detail: &str) {
        self.send(detail, 1.0, "done");
    }

    pub fn fail(&self, detail: &str) {
        self.send(detail, 1.0, "error");
    }
}
