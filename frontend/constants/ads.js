import { TestIds } from 'react-native-google-mobile-ads';

// Set to false when you are ready to release with real AdMob IDs
const USE_TEST_ADS = false; 

// Replace these with your actual AdMob Production Unit IDs
const productionAdUnits = {
  BANNER: 'ca-app-pub-5673428752900879/3567059813',
  INTERSTITIAL: 'ca-app-pub-5673428752900879/5295074457',
  REWARDED: 'ca-app-pub-5673428752900879/4841253663',
};

export const AdUnits = {
  BANNER: (__DEV__ || USE_TEST_ADS) ? TestIds.BANNER : productionAdUnits.BANNER,
  INTERSTITIAL: (__DEV__ || USE_TEST_ADS) ? TestIds.INTERSTITIAL : productionAdUnits.INTERSTITIAL,
  REWARDED: (__DEV__ || USE_TEST_ADS) ? TestIds.REWARDED : productionAdUnits.REWARDED,
};
