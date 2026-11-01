// Background jobs for work that outlasts Claude's wait for a tool call. A
// tool starts the job and returns its id at once; job_status waits for it.
// While a job runs, tools that change Ardour refuse, so nothing changes the
// mix under the job.

const jobs = new Map();
let seq = 0;

const MAX_WAIT_S = 50;
const KEEP_FINISHED = 20;

/** Start `run(progress)` in the background and return the job's summary. */
export function startJob(kind, run) {
  const busy = runningJob();
  if (busy) throw new Error(busyMessage(busy));
  const job = { id: `job-${++seq}`, kind, status: "running", started: Date.now(), progress: [], waiters: [] };
  jobs.set(job.id, job);
  const progress = (line) => job.progress.push(line);
  Promise.resolve()
    .then(() => run(progress))
    .then(
      (result) => {
        job.status = "done";
        job.result = result;
      },
      (e) => {
        job.status = "failed";
        job.error = e.message;
      },
    )
    .finally(() => {
      job.finished = Date.now();
      for (const w of job.waiters.splice(0)) w();
      prune();
    });
  return summary(job);
}

/** The job that is running now, if any. */
export function runningJob() {
  for (const j of jobs.values()) if (j.status === "running") return j;
  return null;
}

export function busyMessage(job) {
  return `Mixtools is still working on ${job.kind} (${job.id}). Call job_status with job_id "${job.id}" and wait for it to finish first.`;
}

/** Wait up to `waitSeconds` for a job to finish, then report it. */
export async function jobStatus({ job_id, wait_seconds }) {
  const job = jobs.get(job_id);
  if (!job) throw new Error(`No job "${job_id}". Jobs end when Claude's mixtools extension restarts; start the work again.`);
  const wait = Math.min(Math.max(wait_seconds ?? 45, 0), MAX_WAIT_S);
  if (job.status === "running" && wait > 0) {
    await new Promise((resolve) => {
      const t = setTimeout(resolve, wait * 1000);
      job.waiters.push(() => {
        clearTimeout(t);
        resolve();
      });
    });
  }
  return summary(job);
}

function summary(job) {
  const s = { job_id: job.id, kind: job.kind, status: job.status, seconds: Math.round(((job.finished ?? Date.now()) - job.started) / 1000), progress: job.progress };
  if (job.status === "running") s.next = `Call job_status with job_id "${job.id}" again.`;
  if (job.status === "done") s.result = job.result;
  if (job.status === "failed") s.error = job.error;
  return s;
}

function prune() {
  const done = [...jobs.values()].filter((j) => j.status !== "running");
  for (const j of done.slice(0, Math.max(0, done.length - KEEP_FINISHED))) jobs.delete(j.id);
}
