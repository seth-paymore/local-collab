#!/usr/bin/env node
import { runWorker } from '../lib/job-worker.mjs';
await runWorker(process.argv[2], process.argv[3]).catch(error => { console.error(error.message); process.exitCode = 1; });
