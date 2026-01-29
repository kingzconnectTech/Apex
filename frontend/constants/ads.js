import { TestIds } from 'react-native-google-mobile-ads';

// Replace these with your actual AdMob Production Unit IDs
const productionAdUnits = {
  BANNER: 'ca-app-pub-xxxxxxxxxxxxx/yyyyyyyyyy',
  INTERSTITIAL: 'ca-app-pub-xxxxxxxxxxxxx/yyyyyyyyyy',
  REWARDED: 'ca-app-pub-xxxxxxxxxxxxx/yyyyyyyyyy',
};

export const AdUnits = {
  BANNER: __DEV__ ? TestIds.BANNER : productionAdUnits.BANNER,
  INTERSTITIAL: __DEV__ ? TestIds.INTERSTITIAL : productionAdUnits.INTERSTITIAL,
  REWARDED: __DEV__ ? TestIds.REWARDED : productionAdUnits.REWARDED,
};
