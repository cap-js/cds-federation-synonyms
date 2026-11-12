using { ext.guard as my } from '../../db/schema';

service FeatureService @(path: '/feature') {
  entity Things as projection on my.Things;
}
