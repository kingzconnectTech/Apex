import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Dimensions, ActivityIndicator } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../context/ThemeContext';
import { moderateScale } from '../utils/responsive';

const { width, height } = Dimensions.get('window');

const NoInternetScreen = ({ onRetry }) => {
  const { theme, isDarkMode } = useTheme();
  const styles = createStyles(theme, isDarkMode);
  const [isChecking, setIsChecking] = useState(false);

  const handleRetry = async () => {
    setIsChecking(true);
    const state = await NetInfo.fetch();
    setIsChecking(false);
    if (state.isConnected && state.isInternetReachable !== false) {
      if (onRetry) onRetry();
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.content}>
        <Ionicons 
          name="cloud-offline-outline" 
          size={moderateScale(100)} 
          color={theme.textSecondary} 
          style={styles.icon}
        />
        <Text style={styles.title}>No Internet Connection</Text>
        <Text style={styles.message}>
          Please check your connection and try again.
        </Text>
        
        <TouchableOpacity 
          style={styles.button} 
          onPress={handleRetry}
          disabled={isChecking}
        >
          {isChecking ? (
            <ActivityIndicator color="#fff" size="small" />
          ) : (
            <Text style={styles.buttonText}>Try Again</Text>
          )}
        </TouchableOpacity>
      </View>
    </View>
  );
};

const createStyles = (theme, isDarkMode) => StyleSheet.create({
  container: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: theme.bg,
    zIndex: 99999, // Ensure it sits on top of everything
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  content: {
    alignItems: 'center',
    width: '100%',
    maxWidth: 400,
  },
  icon: {
    marginBottom: 20,
    opacity: 0.8,
  },
  title: {
    fontSize: moderateScale(22),
    fontWeight: 'bold',
    color: theme.text,
    marginBottom: 10,
    textAlign: 'center',
  },
  message: {
    fontSize: moderateScale(16),
    color: theme.textSecondary,
    textAlign: 'center',
    marginBottom: 30,
    lineHeight: 22,
  },
  button: {
    backgroundColor: theme.primary,
    paddingVertical: 12,
    paddingHorizontal: 30,
    borderRadius: 25,
    minWidth: 150,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 3,
    shadowColor: theme.shadow,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
  },
  buttonText: {
    color: '#fff',
    fontSize: moderateScale(16),
    fontWeight: '600',
  },
});

export default NoInternetScreen;
