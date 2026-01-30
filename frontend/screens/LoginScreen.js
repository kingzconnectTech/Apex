import React, { useState } from 'react';
import { 
  View, 
  Text, 
  TextInput, 
  TouchableOpacity, 
  StyleSheet, 
  Alert, 
  ActivityIndicator, 
  KeyboardAvoidingView, 
  Platform,
  ScrollView,
  StatusBar,
  Image
} from 'react-native';
import auth from '@react-native-firebase/auth';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { 
  horizontalScale, 
  verticalScale, 
  moderateScale, 
  getResponsiveFontSize 
} from '../utils/responsive';
import { useTheme } from '../context/ThemeContext';

export default function LoginScreen({ navigation }) {
  const { theme, isDarkMode } = useTheme();
  const styles = createStyles(theme, isDarkMode);
  
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const handleLogin = async () => {
    if (!email || !password) {
      Alert.alert('Error', 'Please enter both email and password');
      return;
    }
    setLoading(true);
    try {
      await auth().signInWithEmailAndPassword(email, password);
    } catch (error) {
      Alert.alert('Login Error', error.message);
    } finally {
      setLoading(false);
    }
  };

  const handleForgotPassword = async () => {
    if (!email) {
      Alert.alert('Error', 'Please enter your email address to reset password');
      return;
    }
    try {
      await auth().sendPasswordResetEmail(email);
      Alert.alert('Success', 'Password reset email sent! Check your inbox.');
    } catch (error) {
      Alert.alert('Error', error.message);
    }
  };

  return (
    <LinearGradient
      colors={isDarkMode ? [theme.bg, '#121611'] : [theme.bg, '#F0F2F5']}
      style={styles.container}
    >
      <StatusBar barStyle={isDarkMode ? "light-content" : "dark-content"} />
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={{ flex: 1 }}
      >
        <ScrollView 
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.headerContainer}>
            <Image 
              source={require('../assets/Logo_B.png')}
              style={{
                width: horizontalScale(500),
                height: horizontalScale(500),
                resizeMode: 'contain',
                marginBottom: verticalScale(-150)
              }}
            />
            <Text style={styles.subtitle}>Welcome Back, Hunter</Text>
          </View>

          <View style={styles.formContainer}>
            <View style={styles.inputWrapper}>
              <Ionicons name="mail-outline" size={moderateScale(20)} color={theme.textSecondary} style={styles.inputIcon} />
              <TextInput
                style={styles.input}
                placeholder="Email Address"
                placeholderTextColor={theme.textSecondary}
                value={email}
                onChangeText={setEmail}
                autoCapitalize="none"
                keyboardType="email-address"
              />
            </View>

            <View style={styles.inputWrapper}>
              <Ionicons name="lock-closed-outline" size={moderateScale(20)} color={theme.textSecondary} style={styles.inputIcon} />
              <TextInput
                style={styles.input}
                placeholder="Password"
                placeholderTextColor={theme.textSecondary}
                value={password}
                onChangeText={setPassword}
                secureTextEntry={!showPassword}
              />
              <TouchableOpacity onPress={() => setShowPassword(!showPassword)}>
                <Ionicons 
                  name={showPassword ? "eye-off-outline" : "eye-outline"} 
                  size={moderateScale(20)} 
                  color={theme.textSecondary} 
                />
              </TouchableOpacity>
            </View>

            <TouchableOpacity onPress={handleForgotPassword} style={styles.forgotPasswordContainer}>
              <Text style={styles.forgotPasswordText}>Forgot Password?</Text>
            </TouchableOpacity>

            <TouchableOpacity 
              onPress={handleLogin}
              disabled={loading}
              activeOpacity={0.8}
            >
              <LinearGradient
                colors={[theme.primary, theme.secondary]}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 0 }}
                style={styles.button}
              >
                {loading ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.buttonText}>LOGIN</Text>
                )}
              </LinearGradient>
            </TouchableOpacity>

            <View style={styles.footerContainer}>
              <Text style={styles.footerText}>New to Apex?</Text>
              <TouchableOpacity onPress={() => navigation.navigate('Register')}>
                <Text style={styles.signupText}>Create Account</Text>
              </TouchableOpacity>
            </View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </LinearGradient>
  );
}

const createStyles = (theme, isDarkMode) => StyleSheet.create({
  container: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    justifyContent: 'center',
    padding: moderateScale(24),
  },
  headerContainer: {
    alignItems: 'center',
    marginBottom: verticalScale(50),
  },
  subtitle: {
    fontSize: getResponsiveFontSize(16),
    color: theme.textSecondary,
    letterSpacing: 1,
  },
  formContainer: {
    width: '100%',
  },
  inputWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.cardBg,
    borderRadius: moderateScale(12),
    marginBottom: verticalScale(16),
    paddingHorizontal: horizontalScale(16),
    height: verticalScale(56),
    borderWidth: 1,
    borderColor: theme.border,
  },
  inputIcon: {
    marginRight: horizontalScale(12),
  },
  input: {
    flex: 1,
    color: theme.text,
    fontSize: getResponsiveFontSize(16),
    height: '100%',
  },
  forgotPasswordContainer: {
    alignSelf: 'flex-end',
    marginBottom: verticalScale(30),
  },
  forgotPasswordText: {
    color: theme.accent,
    fontSize: getResponsiveFontSize(14),
    fontWeight: '600',
  },
  button: {
    height: verticalScale(56),
    borderRadius: moderateScale(28),
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: theme.primary,
    shadowOffset: {
      width: 0,
      height: verticalScale(8),
    },
    shadowOpacity: 0.4,
    shadowRadius: moderateScale(10),
    elevation: 8,
  },
  buttonText: {
    color: '#fff',
    fontSize: getResponsiveFontSize(16),
    fontWeight: 'bold',
    letterSpacing: 1.5,
  },
  footerContainer: {
    flexDirection: 'row',
    justifyContent: 'center',
    marginTop: verticalScale(40),
    alignItems: 'center',
  },
  footerText: {
    color: theme.textSecondary,
    fontSize: getResponsiveFontSize(14),
    marginRight: horizontalScale(8),
  },
  signupText: {
    color: theme.secondary,
    fontSize: getResponsiveFontSize(14),
    fontWeight: 'bold',
  },
});
