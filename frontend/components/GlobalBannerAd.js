import React from 'react';
import { View, StyleSheet } from 'react-native';
import { BannerAd, BannerAdSize } from 'react-native-google-mobile-ads';
import { AdUnits } from '../constants/ads';

export const GlobalBannerAd = () => {
  if (!AdUnits.BANNER) return null;

  return (
    <View style={styles.container}>
      <BannerAd
        unitId={AdUnits.BANNER}
        size={BannerAdSize.ANCHORED_ADAPTIVE_BANNER}
        requestOptions={{
          requestNonPersonalizedAdsOnly: true,
        }}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
    backgroundColor: 'transparent', 
    paddingVertical: 5,
  },
});
