import { TestIds } from 'react-native-google-mobile-ads';

// Replace these with your actual AdMob Production Unit IDs
const productionAdUnits = {
  BANNER: 'ca-app-pub-5673428752900879/3567059813',
  INTERSTITIAL: 'ca-app-pub-5673428752900879/5295074457',
  REWARDED: 'ca-app-pub-5673428752900879/5919064442',
};

// Helper to check if using placeholder
const isPlaceholder = (id) => id.includes('xxxxxxxxxxxxx');

export const AdUnits = {
  BANNER: (__DEV__ || isPlaceholder(productionAdUnits.BANNER)) ? TestIds.BANNER : productionAdUnits.BANNER,
  INTERSTITIAL: (__DEV__ || isPlaceholder(productionAdUnits.INTERSTITIAL)) ? TestIds.INTERSTITIAL : productionAdUnits.INTERSTITIAL,
  REWARDED: (__DEV__ || isPlaceholder(productionAdUnits.REWARDED)) ? TestIds.REWARDED : productionAdUnits.REWARDED,
};
