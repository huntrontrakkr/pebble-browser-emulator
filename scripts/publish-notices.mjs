import { copyFileSync, mkdirSync } from 'node:fs';
mkdirSync('dist/client/licenses', { recursive: true });
copyFileSync('dist/3rdpartylicenses.txt', 'dist/client/licenses/JAVASCRIPT.txt');
// Three's bundled meshoptimizer addon has its own MIT copyright.
copyFileSync('vendor/licenses/MESHOPTIMIZER.txt', 'dist/client/licenses/MESHOPTIMIZER.txt');
