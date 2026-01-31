import React, { useState, useEffect } from 'react';
import { NavigationContainer, DefaultTheme, DarkTheme } from '@react-navigation/native';
import { createStackNavigator } from '@react-navigation/stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import auth from '@react-native-firebase/auth';
import { Ionicons } from '@expo/vector-icons';
import { StatusBar } from 'expo-status-bar';
import { moderateScale } from './utils/responsive';
import { ThemeProvider, useTheme } from './context/ThemeContext';
import { UserProvider } from './context/UserContext';
import messaging from '@react-native-firebase/messaging';
import { saveTokenToDatabase } from './services/notificationService';
import mobileAds from 'react-native-google-mobile-ads';
import NetInfo from '@react-native-community/netinfo';

// Screens
import HomeScreen from './screens/HomeScreen';
import TipsScreen from './screens/TipsScreen';
import MarketScreen from './screens/MarketScreen';
import SettingsScreen from './screens/SettingsScreen';
import LoginScreen from './screens/LoginScreen';
import RegisterScreen from './screens/RegisterScreen';
import MatchDetailsScreen from './screens/MatchDetailsScreen';
import LeoScreen from './screens/LeoScreen';
import TermsScreen from './screens/TermsScreen';
import PrivacyPolicyScreen from './screens/PrivacyPolicyScreen';
import NoInternetScreen from './components/NoInternetScreen';

const Stack = createStackNavigator();
const Tab = createBottomTabNavigator();
const HomeStack = createStackNavigator();
const RootStack = createStackNavigator();

function HomeStackNavigator() {
  const { theme } = useTheme();
  return (
    <HomeStack.Navigator
      screenOptions={{
        headerStyle: {
          backgroundColor: theme.bg,
          elevation: 0,
          shadowOpacity: 0,
          borderBottomWidth: 0,
        },
        headerTintColor: theme.text,
        headerTitleStyle: {
          fontWeight: 'bold',
        },
      }}
    >
      <HomeStack.Screen 
        name="HomeScreen" 
        component={HomeScreen} 
        options={{ headerShown: false }} 
      />
    </HomeStack.Navigator>
  );
}

function MainTabNavigator() {
  const { theme } = useTheme();
  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        tabBarIcon: ({ focused, color, size }) => {
          let iconName;

          if (route.name === 'HomeTab') {
            iconName = focused ? 'home' : 'home-outline';
          } else if (route.name === 'Tips') {
            iconName = focused ? 'bulb' : 'bulb-outline';
          } else if (route.name === 'Market') {
            iconName = focused ? 'cart' : 'cart-outline';
          } else if (route.name === 'Settings') {
            iconName = focused ? 'settings' : 'settings-outline';
          }

          return <Ionicons name={iconName} size={moderateScale(size)} color={color} />;
        },
        tabBarActiveTintColor: theme.primary,
        tabBarInactiveTintColor: theme.textSecondary,
        tabBarStyle: {
          backgroundColor: theme.bg,
          borderTopColor: theme.border,
          borderTopWidth: 0.5,
        },
        headerStyle: {
          backgroundColor: theme.bg,
          elevation: 0,
          shadowOpacity: 0,
          borderBottomWidth: 0,
        },
        headerTintColor: theme.text,
      })}
    >
      <Tab.Screen 
        name="HomeTab" 
        component={HomeStackNavigator} 
        options={{ title: 'Home', headerShown: false }} 
      />
      <Tab.Screen name="Tips" component={TipsScreen} />
      <Tab.Screen name="Market" component={MarketScreen} />
      <Tab.Screen name="Settings" component={SettingsScreen} />
    </Tab.Navigator>
  );
}

function AppStack() {
  const { theme } = useTheme();
  return (
    <RootStack.Navigator screenOptions={{ headerShown: false }}>
      <RootStack.Screen name="MainTabs" component={MainTabNavigator} />
      <RootStack.Screen 
        name="MatchDetails" 
        component={MatchDetailsScreen} 
        options={{ 
          headerShown: true,
          title: 'Match Analysis',
          headerStyle: {
            backgroundColor: theme.bg,
            elevation: 0,
            shadowOpacity: 0,
            borderBottomWidth: 0,
          },
          headerTintColor: theme.text,
        }}
      />
      <RootStack.Screen 
        name="Leo" 
        component={LeoScreen} 
        options={{ headerShown: false }}
      />
      <RootStack.Screen 
        name="Terms" 
        component={TermsScreen} 
        options={{ headerShown: false }}
      />
      <RootStack.Screen 
        name="PrivacyPolicy" 
        component={PrivacyPolicyScreen} 
        options={{ headerShown: false }}
      />
    </RootStack.Navigator>
  );
}

function AuthStack() {
  const { theme } = useTheme();
  return (
    <Stack.Navigator
      screenOptions={{
        headerShown: false,
        cardStyle: { backgroundColor: theme.bg }
      }}
    >
      <Stack.Screen name="Login" component={LoginScreen} />
      <Stack.Screen name="Register" component={RegisterScreen} />
      <Stack.Screen name="Terms" component={TermsScreen} />
      <Stack.Screen name="PrivacyPolicy" component={PrivacyPolicyScreen} />
    </Stack.Navigator>
  );
}

function AppContent() {
  const [initializing, setInitializing] = useState(true);
  const [user, setUser] = useState();
  const [isConnected, setIsConnected] = useState(true);
  const { theme, isDarkMode } = useTheme();

  // Initialize Ads
  useEffect(() => {
    mobileAds()
      .initialize()
      .then(adapterStatuses => {
        // console.log('Ads Initialized', adapterStatuses);
      });
  }, []);

  // Monitor Internet Connection
  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener(state => {
      setIsConnected(state.isConnected !== false);
    });
    return unsubscribe;
  }, []);

  // Handle user state changes
  function onAuthStateChanged(user) {
    setUser(user);
    if (initializing) setInitializing(false);
  }

  useEffect(() => {
    const subscriber = auth().onAuthStateChanged(onAuthStateChanged);
    return subscriber; // unsubscribe on unmount
  }, []);

  // Handle FCM Tokens
  useEffect(() => {
    if (user) {
      // Save token when user logs in
      saveTokenToDatabase(user.uid);

      // Listen for token refresh
      const unsubscribeToken = messaging().onTokenRefresh(token => {
        saveTokenToDatabase(user.uid);
      });

      return unsubscribeToken;
    }
  }, [user]);

  if (initializing) return null; // Or a loading spinner

  const navigationTheme = {
    ...(isDarkMode ? DarkTheme : DefaultTheme),
    colors: {
      ...(isDarkMode ? DarkTheme.colors : DefaultTheme.colors),
      primary: theme.primary,
      background: theme.bg,
      card: theme.bg,
      text: theme.text,
      border: theme.border,
      notification: theme.accent,
    },
  };

  return (
    <>
      <NavigationContainer theme={navigationTheme}>
        <StatusBar style={isDarkMode ? "light" : "dark"} />
        {user ? <AppStack /> : <AuthStack />}
      </NavigationContainer>
      {!isConnected && (
        <NoInternetScreen onRetry={() => {
            NetInfo.fetch().then(state => setIsConnected(state.isConnected !== false));
        }} />
      )}
    </>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <UserProvider>
        <AppContent />
      </UserProvider>
    </ThemeProvider>
  );
}
