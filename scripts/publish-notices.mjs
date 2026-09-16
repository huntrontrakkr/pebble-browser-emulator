import { copyFileSync, mkdirSync } from 'node:fs';
mkdirSync('dist/client/licenses', { recursive: true });
copyFileSync('dist/3rdpartylicenses.txt', 'dist/client/licenses/JAVASCRIPT.txt');
