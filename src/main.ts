/** Worldgen entry point (SPEC.md §10). */
import './styles.css';
import { App } from './app/controller';
import { browserWorkers } from './app/workers';

const root = document.getElementById('app');
if (!root) throw new Error('worldgen: #app element missing from index.html');
const app = new App(root, browserWorkers);
// Debug handle for the console.
(window as unknown as { __worldgen: App }).__worldgen = app;
