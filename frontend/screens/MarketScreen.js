import React, { useState, useEffect, useRef } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, FlatList, Alert, ActivityIndicator, ScrollView, Platform, Animated, Linking, TextInput, Keyboard } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { horizontalScale, verticalScale, moderateScale, getResponsiveFontSize, width } from '../utils/responsive';
import { formatNumber } from '../utils/format';
import { RewardedAd, RewardedAdEventType, AdEventType, BannerAd, BannerAdSize } from 'react-native-google-mobile-ads';
import { useUser } from '../context/UserContext';
import { useTheme } from '../context/ThemeContext';
import { AdUnits } from '../constants/ads';

const adUnitId = AdUnits.REWARDED;

const TOKEN_PACKAGES = [
  {
    id: '1',
    name: 'Starter Pile',
    tokens: 49,
    price: '$1.00',
    bonus: null,
    color: ['#4FACFE', '#00F2FE'], // Cyan/Blue
    icon: 'cube-outline',
    description: 'Perfect for beginners'
  },
  {
    id: '2',
    name: 'Grinder Stash',
    tokens: 250,
    price: '$4.99',
    bonus: '+2% Bonus',
    color: ['#43E97B', '#38F9D7'], // Green/Teal
    popular: true,
    icon: 'layers-outline',
    description: 'Most popular choice'
  },
  {
    id: '3',
    name: 'Pro Sack',
    tokens: 550,
    price: '$9.99',
    bonus: '+12% Bonus',
    color: ['#FA709A', '#FEE140'], // Pink/Gold
    icon: 'briefcase-outline',
    description: 'For serious bettors'
  },
  {
    id: '4',
    name: 'Whale Vault',
    tokens: 1500,
    price: '$24.99',
    bonus: 'BEST VALUE',
    color: ['#667EEA', '#764BA2'], // Purple/Violet
    icon: 'diamond-outline',
    description: 'Maximize your potential'
  }
];

import { GlobalBannerAd } from '../components/GlobalBannerAd';

export default function MarketScreen({ navigation }) {
    const { theme, isDarkMode } = useTheme();
    const styles = createStyles(theme, isDarkMode);
    const { balance, addBalance, transferTokens } = useUser();
    const [loaded, setLoaded] = useState(false);
    const [recipientEmail, setRecipientEmail] = useState('');
    const [transferAmount, setTransferAmount] = useState('');
    const [transferLoading, setTransferLoading] = useState(false);
    const rewardedAd = useRef(null);
    const scrollY = useRef(new Animated.Value(0)).current;

    useEffect(() => {
        const ad = RewardedAd.createForAdRequest(adUnitId, {
            requestNonPersonalizedAdsOnly: true,
        });
        
        rewardedAd.current = ad;

        const unsubscribeLoaded = ad.addAdEventListener(RewardedAdEventType.LOADED, () => {
            setLoaded(true);
        });

        const unsubscribeEarned = ad.addAdEventListener(
            RewardedAdEventType.EARNED_REWARD,
            async reward => {
                try {
                    await addBalance(2);
                    Alert.alert("Success", "You earned 2 APT!");
                } catch (error) {
                    console.error("Error adding reward:", error);
                    Alert.alert("Error", "Could not add tokens. Please contact support.");
                }
            },
        );
        
        const unsubscribeClosed = ad.addAdEventListener(AdEventType.CLOSED, () => {
            setLoaded(false);
            ad.load();
        });

        ad.load();

        return () => {
            unsubscribeLoaded();
            unsubscribeEarned();
            unsubscribeClosed();
        };
    }, []);

    const showAd = () => {
        if (loaded && rewardedAd.current) {
            rewardedAd.current.show();
        } else {
            Alert.alert("Ad not ready", "Please wait a moment for the ad to load.");
        }
    };

    const handleBuy = async (pack) => {
        const message = `Hello, I would like to purchase the ${pack.name} (${pack.tokens} APT) for ${pack.price}.`;
        const url = `https://wa.me/gr/FUTOXBPIVAY4J1?text=${encodeURIComponent(message)}`;

        try {
            const supported = await Linking.canOpenURL(url);
            if (supported) {
                await Linking.openURL(url);
            } else {
                await Linking.openURL(url);
            }
        } catch (err) {
            console.error('An error occurred', err);
            Alert.alert('Error', 'Could not open WhatsApp.');
        }
    };

    const handleTransfer = async () => {
        if (!recipientEmail || !transferAmount) {
            Alert.alert('Missing Fields', 'Please enter recipient email and amount.');
            return;
        }

        const amount = parseInt(transferAmount);
        if (isNaN(amount) || amount <= 0) {
            Alert.alert('Invalid Amount', 'Please enter a valid positive number.');
            return;
        }

        Alert.alert(
            'Confirm Transfer',
            `Are you sure you want to send ${amount} APT to ${recipientEmail}?`,
            [
                { text: 'Cancel', style: 'cancel' },
                { 
                    text: 'Send', 
                    onPress: async () => {
                        Keyboard.dismiss();
                        setTransferLoading(true);
                        try {
                            await transferTokens(recipientEmail.trim(), amount);
                            Alert.alert('Success', `Successfully sent ${amount} APT to ${recipientEmail}`);
                            setRecipientEmail('');
                            setTransferAmount('');
                        } catch (error) {
                            Alert.alert('Transfer Failed', error.message);
                        } finally {
                            setTransferLoading(false);
                        }
                    }
                }
            ]
        );
    };

    const renderHeader = () => (
        <View>
            <LinearGradient
                colors={[theme.primary, theme.bg]}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={styles.heroSection}
            >
                <View style={styles.patternOverlay} />
                <SafeAreaView edges={['top']} style={styles.safeArea}>
                    <View style={styles.header}>
                        <View>
                            <Text style={styles.headerTitle}>Token Store</Text>
                            <Text style={styles.headerSubtitle}>Fuel your predictions</Text>
                        </View>
                        <TouchableOpacity style={styles.historyBtn}>
                            <Ionicons name="time-outline" size={24} color={theme.white} />
                        </TouchableOpacity>
                    </View>

                    {/* Balance Card - Floating Effect */}
                    <View style={styles.balanceContainer}>
                        <LinearGradient
                            colors={['#FFD700', '#FFA500']}
                            start={{x: 0, y: 0}}
                            end={{x: 1, y: 1}}
                            style={styles.balanceCard}
                        >
                            <View style={styles.balanceContent}>
                                <View>
                                    <Text style={styles.balanceLabel}>CURRENT BALANCE</Text>
                                    <View style={styles.balanceRow}>
                                        <Ionicons name="wallet" size={32} color="#000" />
                                        <Text style={styles.balanceAmount}>{formatNumber(balance)}</Text>
                                        <Text style={styles.balanceUnit}>APT</Text>
                                    </View>
                                </View>
                                <View style={styles.addBtnContainer}>
                                    <View style={styles.addBtn}>
                                        <Ionicons name="add" size={24} color="#FFF" />
                                    </View>
                                </View>
                            </View>
                            <View style={styles.balanceDecor}>
                                <Ionicons name="logo-bitcoin" size={100} color="rgba(255,255,255,0.2)" />
                            </View>
                        </LinearGradient>
                    </View>
                </SafeAreaView>
            </LinearGradient>

            {/* Free Tokens Section */}
            <View style={styles.sectionContainer}>
                <Text style={styles.sectionTitle}>Daily Rewards</Text>
                <TouchableOpacity 
                    style={[styles.freeCard, !loaded && styles.disabledCard]} 
                    onPress={showAd}
                    disabled={!loaded}
                    activeOpacity={0.9}
                >
                    <LinearGradient
                        colors={[theme.cardBg, theme.cardBg]}
                        style={styles.freeCardGradient}
                        start={{x: 0, y: 0}}
                        end={{x: 1, y: 1}}
                    >
                        <View style={styles.freeCardBorder} />
                        <View style={styles.freeContent}>
                            <LinearGradient
                                colors={['#FF416C', '#FF4B2B']}
                                style={styles.freeIconContainer}
                            >
                                <Ionicons name="play" size={24} color="#FFF" />
                            </LinearGradient>
                            <View style={styles.freeTextContainer}>
                                <Text style={styles.freeTitle}>Watch Short Ad</Text>
                                <Text style={styles.freeSubtitle}>Get +2 Free APT instantly</Text>
                            </View>
                            <View style={styles.freeButton}>
                                    {loaded ? (
                                    <Text style={styles.freeButtonText}>CLAIM</Text>
                                    ) : (
                                    <ActivityIndicator size="small" color="#FFF" />
                                    )}
                            </View>
                        </View>
                    </LinearGradient>
                </TouchableOpacity>
            </View>

            {/* Transfer Section */}
            <View style={styles.sectionContainer}>
                <Text style={styles.sectionTitle}>Transfer Tokens</Text>
                <View style={styles.transferCard}>
                    <View style={styles.inputRow}>
                        <Text style={styles.inputLabel}>Recipient Email</Text>
                        <TextInput
                            style={styles.input}
                            placeholder="Enter user email"
                            placeholderTextColor={theme.textSecondary}
                            value={recipientEmail}
                            onChangeText={setRecipientEmail}
                            keyboardType="email-address"
                            autoCapitalize="none"
                        />
                    </View>
                    <View style={styles.inputRow}>
                        <Text style={styles.inputLabel}>Amount</Text>
                        <TextInput
                            style={styles.input}
                            placeholder="0"
                            placeholderTextColor={theme.textSecondary}
                            value={transferAmount}
                            onChangeText={setTransferAmount}
                            keyboardType="numeric"
                        />
                    </View>
                    <TouchableOpacity 
                        style={styles.sendButton} 
                        onPress={handleTransfer}
                        disabled={transferLoading}
                    >
                        <LinearGradient
                            colors={['#667EEA', '#764BA2']}
                            start={{x: 0, y: 0}}
                            end={{x: 1, y: 0}}
                            style={styles.sendButtonGradient}
                        >
                            {transferLoading ? (
                                <ActivityIndicator color="#FFF" size="small" />
                            ) : (
                                <Text style={styles.sendButtonText}>SEND TOKENS</Text>
                            )}
                        </LinearGradient>
                    </TouchableOpacity>
                </View>
            </View>

            <Text style={styles.sectionTitle}>Buy Tokens</Text>
        </View>
    );

    const renderPackage = ({ item }) => (
        <TouchableOpacity 
            activeOpacity={0.9}
            onPress={() => handleBuy(item)}
            style={styles.packageCardContainer}
        >
            <View style={[styles.packageCard, item.popular && styles.popularCardBorder]}>
                {item.popular && (
                    <LinearGradient
                        colors={[theme.primary, theme.warning]}
                        start={{x: 0, y: 0}}
                        end={{x: 1, y: 0}}
                        style={styles.popularBadge}
                    >
                        <Text style={styles.popularText}>MOST POPULAR</Text>
                    </LinearGradient>
                )}
                
                <LinearGradient
                    colors={[theme.cardBg, theme.cardBg]}
                    style={styles.cardContent}
                >
                    <View style={styles.cardHeader}>
                         <LinearGradient colors={item.color} style={styles.iconBackground}>
                            <Ionicons name={item.icon} size={moderateScale(24)} color="#FFF" />
                         </LinearGradient>
                         {item.bonus && (
                            <View style={styles.bonusBadge}>
                                <Text style={styles.bonusText}>{item.bonus}</Text>
                            </View>
                         )}
                    </View>

                    <View style={styles.infoContainer}>
                        <Text style={styles.packageName}>{item.name}</Text>
                        <View style={styles.tokenRow}>
                            <Text style={styles.tokenAmount}>{formatNumber(item.tokens)}</Text>
                            <Text style={styles.tokenLabel}>APT</Text>
                        </View>
                    </View>

                    <TouchableOpacity style={styles.priceButton} onPress={() => handleBuy(item)}>
                        <Text style={styles.priceText}>{item.price}</Text>
                        <Ionicons name="arrow-forward" size={14} color={theme.white} />
                    </TouchableOpacity>
                </LinearGradient>
            </View>
        </TouchableOpacity>
    );

    return (
        <View style={styles.container}>
            <FlatList
                data={TOKEN_PACKAGES}
                renderItem={renderPackage}
                keyExtractor={item => item.id}
                numColumns={2}
                columnWrapperStyle={styles.columnWrapper}
                contentContainerStyle={styles.listContent}
                showsVerticalScrollIndicator={false}
                ListHeaderComponent={renderHeader()}
            />
            <View style={{ alignItems: 'center', backgroundColor: theme.bg }}>
                <GlobalBannerAd />
            </View>
        </View>
    );
}

const createStyles = (theme, isDarkMode) => StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.bg,
  },
  safeArea: {
    marginBottom: verticalScale(20),
  },
  heroSection: {
    paddingBottom: verticalScale(40),
    borderBottomLeftRadius: moderateScale(30),
    borderBottomRightRadius: moderateScale(30),
    marginBottom: verticalScale(20),
    position: 'relative',
    overflow: 'hidden',
  },
  patternOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.2)',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: moderateScale(20),
    paddingTop: verticalScale(10),
    marginBottom: verticalScale(20),
  },
  headerTitle: {
    fontSize: getResponsiveFontSize(28),
    fontWeight: '900',
    color: theme.white,
    letterSpacing: 0.5,
  },
  headerSubtitle: {
    fontSize: getResponsiveFontSize(14),
    color: isDarkMode ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.6)',
    fontWeight: '500',
  },
  historyBtn: {
    width: horizontalScale(44),
    height: horizontalScale(44),
    backgroundColor: isDarkMode ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)',
    borderRadius: moderateScale(14),
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: isDarkMode ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)',
  },
  balanceContainer: {
    paddingHorizontal: moderateScale(20),
  },
  balanceCard: {
    borderRadius: moderateScale(24),
    padding: moderateScale(24),
    position: 'relative',
    overflow: 'hidden',
    height: verticalScale(160),
    justifyContent: 'center',
    shadowColor: '#FFD700',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.3,
    shadowRadius: 16,
    elevation: 10,
  },
  balanceContent: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    zIndex: 1,
  },
  balanceLabel: {
    color: 'rgba(0,0,0,0.6)',
    fontSize: getResponsiveFontSize(12),
    fontWeight: '800',
    marginBottom: verticalScale(8),
    letterSpacing: 1,
  },
  balanceRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  balanceAmount: {
    color: '#000',
    fontSize: getResponsiveFontSize(42),
    fontWeight: '900',
    marginLeft: horizontalScale(8),
    marginRight: horizontalScale(8),
  },
  balanceUnit: {
    color: 'rgba(0,0,0,0.7)',
    fontSize: getResponsiveFontSize(16),
    fontWeight: '700',
    marginTop: verticalScale(14),
  },
  addBtnContainer: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  addBtn: {
    width: horizontalScale(40),
    height: horizontalScale(40),
    borderRadius: horizontalScale(20),
    backgroundColor: '#000',
    justifyContent: 'center',
    alignItems: 'center',
  },
  balanceDecor: {
    position: 'absolute',
    right: -20,
    bottom: -30,
    opacity: 0.5,
    transform: [{ rotate: '-15deg' }]
  },
  sectionContainer: {
    paddingHorizontal: moderateScale(20),
    marginBottom: verticalScale(24),
  },
  sectionTitle: {
    fontSize: getResponsiveFontSize(18),
    fontWeight: '800',
    color: theme.text,
    marginLeft: moderateScale(20),
    marginBottom: verticalScale(16),
    marginTop: verticalScale(8),
  },
  freeCard: {
    borderRadius: moderateScale(20),
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 5,
  },
  disabledCard: {
    opacity: 0.6,
  },
  freeCardGradient: {
    borderRadius: moderateScale(20),
    padding: moderateScale(2), // Border effect
  },
  freeCardBorder: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: moderateScale(20),
    borderWidth: 1,
    borderColor: isDarkMode ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)',
  },
  freeContent: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.cardBg,
    borderRadius: moderateScale(18),
    padding: moderateScale(16),
  },
  freeIconContainer: {
    width: horizontalScale(48),
    height: horizontalScale(48),
    borderRadius: moderateScale(16),
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: horizontalScale(16),
  },
  freeTextContainer: {
    flex: 1,
  },
  freeTitle: {
    color: theme.text,
    fontSize: getResponsiveFontSize(16),
    fontWeight: 'bold',
    marginBottom: verticalScale(4),
  },
  freeSubtitle: {
    color: theme.textSecondary,
    fontSize: getResponsiveFontSize(12),
    fontWeight: '500',
  },
  freeButton: {
    backgroundColor: theme.primary,
    paddingHorizontal: horizontalScale(16),
    paddingVertical: verticalScale(8),
    borderRadius: moderateScale(12),
    minWidth: horizontalScale(70),
    alignItems: 'center',
  },
  freeButtonText: {
    color: '#FFF',
    fontWeight: '800',
    fontSize: getResponsiveFontSize(11),
    letterSpacing: 0.5,
  },
  transferCard: {
    borderRadius: moderateScale(20),
    backgroundColor: theme.cardBg,
    padding: moderateScale(20),
    marginBottom: verticalScale(24),
    borderWidth: 1,
    borderColor: isDarkMode ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)',
  },
  inputRow: {
    marginBottom: verticalScale(16),
  },
  inputLabel: {
    color: theme.textSecondary,
    fontSize: getResponsiveFontSize(12),
    marginBottom: verticalScale(8),
    fontWeight: '600',
  },
  input: {
    backgroundColor: isDarkMode ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)',
    borderRadius: moderateScale(12),
    paddingHorizontal: horizontalScale(16),
    paddingVertical: verticalScale(12),
    color: theme.text,
    fontSize: getResponsiveFontSize(14),
    borderWidth: 1,
    borderColor: 'transparent',
  },
  sendButton: {
    borderRadius: moderateScale(12),
    overflow: 'hidden',
    marginTop: verticalScale(8),
  },
  sendButtonGradient: {
    paddingVertical: verticalScale(12),
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendButtonText: {
    color: '#FFF',
    fontSize: getResponsiveFontSize(14),
    fontWeight: 'bold',
    letterSpacing: 0.5,
  },
  listContent: {
    paddingHorizontal: moderateScale(20),
    paddingBottom: verticalScale(100),
  },
  columnWrapper: {
    justifyContent: 'space-between',
  },
  packageCardContainer: {
    width: '48%',
    marginBottom: verticalScale(16),
  },
  packageCard: {
    borderRadius: moderateScale(24),
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 4,
  },
  popularCardBorder: {
    transform: [{ scale: 1.02 }],
  },
  cardContent: {
    padding: moderateScale(16),
    borderRadius: moderateScale(24),
    borderWidth: 1,
    borderColor: isDarkMode ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)',
  },
  popularBadge: {
    position: 'absolute',
    top: -10,
    alignSelf: 'center',
    paddingHorizontal: horizontalScale(12),
    paddingVertical: verticalScale(4),
    borderRadius: moderateScale(12),
    zIndex: 10,
    shadowColor: theme.primary,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
    elevation: 5,
  },
  popularText: {
    color: '#FFF',
    fontSize: getResponsiveFontSize(10),
    fontWeight: '900',
    letterSpacing: 0.5,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: verticalScale(12),
  },
  iconBackground: {
    width: horizontalScale(44),
    height: horizontalScale(44),
    borderRadius: moderateScale(14),
    justifyContent: 'center',
    alignItems: 'center',
  },
  bonusBadge: {
    backgroundColor: 'rgba(76, 175, 80, 0.15)',
    paddingHorizontal: horizontalScale(6),
    paddingVertical: verticalScale(2),
    borderRadius: moderateScale(4),
    borderWidth: 1,
    borderColor: 'rgba(76, 175, 80, 0.3)',
  },
  bonusText: {
    color: '#4CAF50',
    fontSize: getResponsiveFontSize(10),
    fontWeight: '700',
  },
  infoContainer: {
    marginBottom: verticalScale(16),
  },
  packageName: {
    color: theme.textSecondary,
    fontSize: getResponsiveFontSize(12),
    fontWeight: '600',
    marginBottom: verticalScale(4),
  },
  tokenRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
  },
  tokenAmount: {
    color: theme.text,
    fontSize: getResponsiveFontSize(22),
    fontWeight: '800',
    marginRight: horizontalScale(4),
  },
  tokenLabel: {
    color: theme.textSecondary,
    fontSize: getResponsiveFontSize(12),
    fontWeight: '600',
  },
  priceButton: {
    width: '100%',
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: isDarkMode ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)',
    paddingVertical: verticalScale(12),
    borderRadius: moderateScale(14),
    borderWidth: 1,
    borderColor: isDarkMode ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)',
  },
  priceText: {
    color: theme.white,
    fontWeight: '700',
    fontSize: getResponsiveFontSize(14),
    marginRight: horizontalScale(4),
  },
});