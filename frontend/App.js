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

// Error boundary to catch startup errors
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error('App ErrorBoundary caught an error:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      console.error('Fatal error:', this.state.error);
      return null;
    }
    return this.props.children;
  }
}

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
import LiveAnalysisScreen from './screens/LiveAnalysisScreen';
import LiveMatchesScreen from './screens/LiveMatchesScreen';
import NoInternetScreen from './components/NoInternetScreen';
import AdminPicksScreen from './screens/AdminPicksScreen';
import AdminDashboardScreen from './screens/admin/AdminDashboardScreen';
import AdminUploadScreen from './screens/admin/AdminUploadScreen';
import AdminManageScreen from './screens/admin/AdminManageScreen';
import AdminHistoryScreen from './screens/admin/AdminHistoryScreen';
import AdminRoute from './components/AdminRoute';
import { AdminProvider } from './context/AdminContext';

// Admin screens render inside AdminRoute, which only lets a user through AFTER
// Firebase confirms the `admin: true` custom claim (and Firestore rules enforce
// it server-side regardless). Declared at module scope so they are stable.
const AdminDashboardGuarded = props => (
  <AdminRoute {...props}><AdminDashboardScreen {...props} /></AdminRoute>
);
const AdminUploadGuarded = props => (
  <AdminRoute {...props}><AdminUploadScreen {...props} /></AdminRoute>
);
const AdminManageGuarded = props => (
  <AdminRoute {...props}><AdminManageScreen {...props} /></AdminRoute>
);
const AdminHistoryGuarded = props => (
  <AdminRoute {...props}><AdminHistoryScreen {...props} /></AdminRoute>
);

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
      <RootStack.Screen 
        name="LiveAnalysis" 
        component={LiveAnalysisScreen} 
        options={{ 
          headerShown: true,
          title: 'Live Game Analysis',
          headerStyle: {
            backgroundColor: theme.bg,
            elevation: 0,
            shadowOpacity: 0,
            borderBottomWidth: 0,
          },
          headerTintColor: theme.text,
        }}
      />

      {/* Live Matches — the games in play now, read from FlashScore / LiveScore,
          opened in an in-app browser. */}
      <RootStack.Screen
        name="LiveMatches"
        component={LiveMatchesScreen}
        options={{ ...adminHeader(theme, 'Live Matches') }}
      />

      {/* User-facing Admin Picks — predictions uploaded by an administrator.
          Completely separate from the AI prediction engine. */}
      <RootStack.Screen
        name="AdminPicks"
        component={AdminPicksScreen}
        options={{ ...adminHeader(theme, 'Admin Picks') }}
      />

      {/* Administrator experience (guarded by the `admin: true` custom claim). */}
      <RootStack.Screen
        name="AdminDashboard"
        component={AdminDashboardGuarded}
        options={{ ...adminHeader(theme, 'Admin Dashboard') }}
      />
      <RootStack.Screen
        name="AdminUpload"
        component={AdminUploadGuarded}
        options={{ ...adminHeader(theme, 'Upload Prediction') }}
      />
      <RootStack.Screen
        name="AdminManage"
        component={AdminManageGuarded}
        options={{ ...adminHeader(theme, 'Manage Predictions') }}
      />
      <RootStack.Screen
        name="AdminHistory"
        component={AdminHistoryGuarded}
        options={{ ...adminHeader(theme, 'Prediction History') }}
      />
    </RootStack.Navigator>
  );
}

/** Shared header styling for the admin screens. */
function adminHeader(theme, title) {
  return {
    headerShown: true,
    title,
    headerStyle: {
      backgroundColor: theme.bg,
      elevation: 0,
      shadowOpacity: 0,
      borderBottomWidth: 0,
    },
    headerTintColor: theme.text,
  };
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
    try {
      mobileAds()
        .initialize()
        .then(adapterStatuses => {
          console.log('Ads Initialized', adapterStatuses);
        })
        .catch(error => {
          console.error('Failed to initialize ads:', error);
        });
    } catch (error) {
      console.error('Ads initialization error:', error);
    }
  }, []);

  // Monitor Internet Connection
  useEffect(() => {
    try {
      const unsubscribe = NetInfo.addEventListener(state => {
        setIsConnected(state.isConnected !== false);
      });
      return unsubscribe;
    } catch (error) {
      console.error('NetInfo error:', error);
      setIsConnected(true); // Assume connected if error
    }
  }, []);

  // Handle user state changes
  function onAuthStateChanged(user) {
    try {
      setUser(user);
      if (initializing) setInitializing(false);
    } catch (error) {
      console.error('Auth state change error:', error);
      if (initializing) setInitializing(false);
    }
  }

  useEffect(() => {
    try {
      const subscriber = auth().onAuthStateChanged(onAuthStateChanged);
      return subscriber; // unsubscribe on unmount
    } catch (error) {
      console.error('Auth initialization error:', error);
      setInitializing(false); // Continue without auth
    }
  }, []);

  // Handle FCM Tokens
  useEffect(() => {
    if (user) {
      try {
        // Save token when user logs in
        saveTokenToDatabase(user.uid);

        // Listen for token refresh
        const unsubscribeToken = messaging().onTokenRefresh(token => {
          saveTokenToDatabase(user.uid);
        });

        return unsubscribeToken;
      } catch (error) {
        console.error('FCM token error:', error);
      }
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
    <ErrorBoundary>
      <ThemeProvider>
        <UserProvider>
          <AdminProvider>
            <AppContent />
          </AdminProvider>
        </UserProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}
