using { ext.guard as my } from '../db/schema';

service AppService @(path: '/app') {
  entity Things as projection on my.Things;
}
