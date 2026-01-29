import React, { useState, useEffect, useRef } from 'react';
import { 
  View, 
  Text, 
  TextInput, 
  TouchableOpacity, 
  StyleSheet, 
  Alert, 
  ActivityIndicator, 
  Platform,
  KeyboardAvoidingView,
  ScrollView,
  Animated,
  Easing,
  StatusBar
} from 'react-native';
import auth from '@react-native-firebase/auth';
import firestore from '@react-native-firebase/firestore';
import DateTimePicker from '@react-native-community/datetimepicker';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { 
  horizontalScale, 
  verticalScale, 
  moderateScale, 
  getResponsiveFontSize 
} from '../utils/responsive';
import { useTheme } from '../context/ThemeContext';

export default function RegisterScreen({ navigation }) {
  const { theme, isDarkMode } = useTheme();
  const styles = createStyles(theme, isDarkMode);

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [dob, setDob] = useState(new Date());
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [dobSet, setDobSet] = useState(false);
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [agreeToTerms, setAgreeToTerms] = useState(false);
  const [focusedInput, setFocusedInput] = useState(null);

  // Animation values
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(50)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 800,
        useNativeDriver: true,
      }),
      Animated.timing(slideAnim, {
        toValue: 0,
        duration: 800,
        easing: Easing.out(Easing.exp),
        useNativeDriver: true,
      }),
    ]).start();
  }, []);

  const calculateAge = (birthDate) => {
    const today = new Date();
    let age = today.getFullYear() - birthDate.getFullYear();
    const m = today.getMonth() - birthDate.getMonth();
    if (m < 0 || (m === 0 && today.getDate() < birthDate.getDate())) {
      age--;
    }
    return age;
  };

  const onDateChange = (event, selectedDate) => {
    const currentDate = selectedDate || dob;
    setShowDatePicker(Platform.OS === 'ios');
    setDob(currentDate);
    setDobSet(true);
  };

  const formatDate = (date) => {
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  };

  const handleRegister = async () => {
    if (!name || !email || !password || !confirmPassword || !dobSet) {
      Alert.alert('Missing Information', 'Please fill in all fields to continue.');
      return;
    }

    if (password !== confirmPassword) {
      Alert.alert('Password Mismatch', 'Your passwords do not match. Please try again.');
      return;
    }

    if (!agreeToTerms) {
      Alert.alert('Terms of Service', 'You must agree to the Terms and Privacy Policy to register.');
      return;
    }

    const age = calculateAge(dob);
    if (age < 18) {
      Alert.alert('Age Restriction', 'You must be at least 18 years old to join Apex.');
      return;
    }

    setLoading(true);
    try {
      const userCredential = await auth().createUserWithEmailAndPassword(email, password);
      await userCredential.user.updateProfile({
        displayName: name,
      });

      // Create user document in Firestore
      await firestore().collection('users').doc(userCredential.user.uid).set({
        email: email,
        registrationDate: firestore.FieldValue.serverTimestamp(),
        lastActive: firestore.FieldValue.serverTimestamp(),
        tokens: 30, // Initial token balance
        fcmTokens: [], // Initialize empty array for FCM tokens
        name: name,
        dob: dob,
      });

      Alert.alert('Welcome to Apex!', 'Your account has been created successfully.', [
        { text: 'Let\'s Go', onPress: () => {} } // Navigation is usually handled by auth state listener
      ]);
    } catch (error) {
      let errorMessage = 'Something went wrong. Please try again.';
      if (error.code === 'auth/email-already-in-use') {
        errorMessage = 'That email address is already in use!';
      } else if (error.code === 'auth/invalid-email') {
        errorMessage = 'That email address is invalid!';
      } else if (error.code === 'auth/weak-password') {
        errorMessage = 'Password should be at least 6 characters.';
      }
      Alert.alert('Registration Failed', errorMessage);
    } finally {
      setLoading(false);
    }
  };

  const InputField = ({ 
    icon, 
    placeholder, 
    value, 
    onChangeText, 
    secureTextEntry, 
    toggleSecure, 
    isSecureVisible,
    keyboardType = 'default',
    autoCapitalize = 'none',
    onFocusName
  }) => (
    <View style={[
      styles.inputWrapper,
      focusedInput === onFocusName && styles.inputWrapperFocused
    ]}>
      <Ionicons 
        name={icon} 
        size={moderateScale(20)} 
        color={focusedInput === onFocusName ? theme.primary : theme.textSecondary} 
        style={styles.inputIcon} 
      />
      <TextInput
        style={styles.input}
        placeholder={placeholder}
        placeholderTextColor={theme.textSecondary}
        value={value}
        onChangeText={onChangeText}
        autoCapitalize={autoCapitalize}
        keyboardType={keyboardType}
        secureTextEntry={secureTextEntry}
        onFocus={() => setFocusedInput(onFocusName)}
        onBlur={() => setFocusedInput(null)}
      />
      {toggleSecure && (
        <TouchableOpacity onPress={toggleSecure}>
          <Ionicons 
            name={isSecureVisible ? "eye-off-outline" : "eye-outline"} 
            size={moderateScale(20)} 
            color={theme.textSecondary} 
          />
        </TouchableOpacity>
      )}
    </View>
  );

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
            <TouchableOpacity 
              onPress={() => navigation.goBack()}
              style={styles.backButton}
            >
              <Ionicons name="arrow-back" size={moderateScale(24)} color={theme.text} />
            </TouchableOpacity>
            <Text style={styles.title}>Create Account</Text>
            <Text style={styles.subtitle}>Join the Apex Community</Text>
          </View>

          <Animated.View 
            style={[
              styles.formContainer,
              {
                opacity: fadeAnim,
                transform: [{ translateY: slideAnim }]
              }
            ]}
          >
            <InputField 
              icon="person-outline"
              placeholder="Full Name"
              value={name}
              onChangeText={setName}
              autoCapitalize="words"
              onFocusName="name"
            />

            <TouchableOpacity 
              style={[
                styles.inputWrapper,
                focusedInput === 'dob' && styles.inputWrapperFocused
              ]} 
              onPress={() => {
                setFocusedInput('dob');
                setShowDatePicker(true);
              }}
            >
              <Ionicons 
                name="calendar-outline" 
                size={moderateScale(20)} 
                color={focusedInput === 'dob' ? theme.primary : theme.textSecondary} 
                style={styles.inputIcon} 
              />
              <Text style={[
                styles.inputText, 
                !dobSet && { color: theme.textSecondary }
              ]}>
                {dobSet ? formatDate(dob) : 'Date of Birth'}
              </Text>
              {dobSet && (
                <Ionicons name="checkmark-circle" size={moderateScale(18)} color={theme.success} />
              )}
            </TouchableOpacity>

            {showDatePicker && (
              <DateTimePicker
                testID="dateTimePicker"
                value={dob}
                mode="date"
                is24Hour={true}
                display="default"
                onChange={onDateChange}
                maximumDate={new Date()}
              />
            )}

            <InputField 
              icon="mail-outline"
              placeholder="Email Address"
              value={email}
              onChangeText={setEmail}
              keyboardType="email-address"
              onFocusName="email"
            />

            <InputField 
              icon="lock-closed-outline"
              placeholder="Password"
              value={password}
              onChangeText={setPassword}
              secureTextEntry={!showPassword}
              toggleSecure={() => setShowPassword(!showPassword)}
              isSecureVisible={showPassword}
              onFocusName="password"
            />

            <InputField 
              icon="shield-checkmark-outline"
              placeholder="Confirm Password"
              value={confirmPassword}
              onChangeText={setConfirmPassword}
              secureTextEntry={!showConfirmPassword}
              toggleSecure={() => setShowConfirmPassword(!showConfirmPassword)}
              isSecureVisible={showConfirmPassword}
              onFocusName="confirmPassword"
            />

            <TouchableOpacity 
              style={styles.termsContainer}
              onPress={() => setAgreeToTerms(!agreeToTerms)}
            >
              <View style={[styles.checkbox, agreeToTerms && styles.checkboxChecked]}>
                {agreeToTerms && <Ionicons name="checkmark" size={moderateScale(14)} color={theme.bg} />}
              </View>
              <Text style={styles.termsText}>
                I agree to the <Text style={styles.linkHighlight}>Terms of Service</Text> and <Text style={styles.linkHighlight}>Privacy Policy</Text>
              </Text>
            </TouchableOpacity>

            <TouchableOpacity 
              onPress={handleRegister}
              disabled={loading}
              activeOpacity={0.8}
              style={styles.buttonContainer}
            >
              <LinearGradient
                colors={loading ? [theme.textSecondary, theme.textSecondary] : [theme.primary, theme.secondary]}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 0 }}
                style={styles.button}
              >
                {loading ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.buttonText}>SIGN UP</Text>
                )}
              </LinearGradient>
            </TouchableOpacity>

            <View style={styles.footerContainer}>
              <Text style={styles.footerText}>Already have an account?</Text>
              <TouchableOpacity onPress={() => navigation.navigate('Login')}>
                <Text style={styles.loginText}>Login</Text>
              </TouchableOpacity>
            </View>
          </Animated.View>
        </ScrollView>
      </KeyboardAvoidingView>
    </LinearGradient>
  );
}

function createStyles(theme, isDarkMode) {
  return StyleSheet.create({
    container: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    padding: moderateScale(24),
    paddingTop: verticalScale(60),
  },
  headerContainer: {
    marginBottom: verticalScale(30),
  },
  backButton: {
    width: horizontalScale(40),
    height: horizontalScale(40),
    borderRadius: moderateScale(20),
    backgroundColor: theme.cardBg,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: verticalScale(20),
  },
  title: {
    fontSize: getResponsiveFontSize(32),
    fontWeight: '800',
    color: theme.text,
    marginBottom: verticalScale(8),
  },
  subtitle: {
    fontSize: getResponsiveFontSize(16),
    color: theme.textSecondary,
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
  inputWrapperFocused: {
    borderColor: theme.primary,
    backgroundColor: isDarkMode ? 'rgba(98, 129, 65, 0.1)' : 'rgba(98, 129, 65, 0.05)',
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
  inputText: {
    flex: 1,
    color: theme.text,
    fontSize: getResponsiveFontSize(16),
  },
  termsContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: verticalScale(24),
    marginTop: verticalScale(8),
  },
  checkbox: {
    width: horizontalScale(20),
    height: horizontalScale(20),
    borderRadius: moderateScale(4),
    borderWidth: 1,
    borderColor: theme.primary,
    marginRight: horizontalScale(10),
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'transparent',
  },
  checkboxChecked: {
    backgroundColor: theme.primary,
  },
  termsText: {
    flex: 1,
    color: theme.textSecondary,
    fontSize: getResponsiveFontSize(13),
    lineHeight: verticalScale(18),
  },
  buttonContainer: {
    marginTop: 0,
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
    marginTop: verticalScale(30),
    alignItems: 'center',
    marginBottom: verticalScale(20),
  },
  footerText: {
    color: theme.textSecondary,
    fontSize: getResponsiveFontSize(14),
    marginRight: horizontalScale(8),
  },
  loginText: {
    color: theme.secondary,
    fontSize: getResponsiveFontSize(14),
    fontWeight: 'bold',
  },
  linkHighlight: {
    color: theme.primary,
    fontWeight: 'bold',
  },
});
}