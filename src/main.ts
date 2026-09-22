import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';
import { switchToWaitingVersion } from './app/launch-update';

void switchToWaitingVersion().then((reloading) => {
  if (!reloading) bootstrapApplication(App, appConfig).catch((err) => console.error(err));
});
