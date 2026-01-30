import React, { useEffect, useState, useCallback, useRef } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, FlatList, ActivityIndicator, Image, RefreshControl, Animated, Dimensions, Platform, StatusBar } from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { horizontalScale, verticalScale, moderateScale, getResponsiveFontSize, width } from '../utils/responsive';
import { formatNumber } from '../utils/format';
import { fetchMatches } from '../services/espn';
import { useUser } from '../context/UserContext';
import { useTheme } from '../context/ThemeContext';
import { GlobalBannerAd } from '../components/GlobalBannerAd';

const CARD_WIDTH = width * 0.75;
const SPACING = horizontalScale(16);

export default function HomeScreen({ navigation }) {
  const { theme, isDarkMode } = useTheme();
  const styles = createStyles(theme, isDarkMode);
  const { balance } = useUser();
  const [allUpcomingMatches, setAllUpcomingMatches] = useState([]);
  const [upcomingMatches, setUpcomingMatches] = useState([]);
  const [liveMatches, setLiveMatches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [dateFilter, setDateFilter] = useState('All');
  
  // Animation values
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const fadeAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    loadMatches();
    startPulseAnimation();
    Animated.timing(fadeAnim, {
      toValue: 1,
      duration: 1000,
      useNativeDriver: true,
    }).start();
  }, []);

  const startPulseAnimation = () => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 1.1,
          duration: 1000,
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 1,
          duration: 1000,
          useNativeDriver: true,
        }),
      ])
    ).start();
  };

  useEffect(() => {
    applyFilter(allUpcomingMatches, dateFilter);
  }, [dateFilter, allUpcomingMatches]);

  const loadMatches = async (showLoading = true) => {
    if (showLoading) setLoading(true);
    try {
      const { live, upcoming } = await fetchMatches();
      setLiveMatches(live);
      setAllUpcomingMatches(upcoming);
    } catch (error) {
      console.error('Error loading matches:', error);
    } finally {
      if (showLoading) setLoading(false);
    }
  };

  const applyFilter = (matches, filter) => {
    if (!matches || matches.length === 0) {
      setUpcomingMatches([]);
      return;
    }

    if (filter === 'All') {
      setUpcomingMatches(matches.slice(0, 10));
    } else {
      const targetDate = new Date();
      if (filter === 'Tomorrow') {
        targetDate.setDate(targetDate.getDate() + 1);
      }
      
      const filtered = matches.filter(item => {
        if (!item.date) return false;
        const itemDate = new Date(item.date);
        return itemDate.toDateString() === targetDate.toDateString();
      });
      setUpcomingMatches(filtered);
    }
  };

  const handleFilterChange = (filter) => {
    setDateFilter(filter);
  };

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadMatches(false);
    setRefreshing(false);
  }, [dateFilter]);

  const renderLiveMatchItem = ({ item }) => (
    <TouchableOpacity 
      style={styles.liveMatchCard} 
      activeOpacity={0.9}
      onPress={() => navigation.navigate('MatchDetails', { match: item })}
    >
      <LinearGradient
        colors={['rgba(255, 68, 68, 0.1)', 'transparent']}
        style={styles.cardGradient}
      />
      <View style={styles.liveHeader}>
        <View style={styles.liveBadge}>
           <Animated.View style={[styles.liveDot, { transform: [{ scale: pulseAnim }] }]} />
           <Text style={styles.liveText}>LIVE</Text>
        </View>
        <Text style={styles.leagueText} numberOfLines={1}>{item.league}</Text>
      </View>
      
      <View style={styles.liveScoreContainer}>
        <View style={styles.liveTeam}>
           <Image source={{ uri: item.homeTeam.logo }} style={styles.liveLogo} />
           <Text style={styles.liveTeamName} numberOfLines={1}>{item.homeTeam.name}</Text>
        </View>
        
        <View style={styles.scoreBox}>
           <Text style={styles.scoreText}>{item.homeTeam.score} - {item.awayTeam.score}</Text>
           <Text style={styles.liveTime}>{item.time}</Text>
        </View>

        <View style={styles.liveTeam}>
           <Image source={{ uri: item.awayTeam.logo }} style={styles.liveLogo} />
           <Text style={styles.liveTeamName} numberOfLines={1}>{item.awayTeam.name}</Text>
        </View>
      </View>
    </TouchableOpacity>
  );

  const renderMatchItem = ({ item }) => (
    <TouchableOpacity 
      style={styles.matchCard} 
      activeOpacity={0.9}
      onPress={() => navigation.navigate('MatchDetails', { match: item })}
    >
      <View style={styles.cardHeaderRow}>
        <View style={styles.leagueBadge}>
          <Text style={styles.leagueBadgeText} numberOfLines={1}>{item.league}</Text>
        </View>
        <View style={styles.timeBadge}>
            <Ionicons name="time-outline" size={12} color={theme.textSecondary} style={{ marginRight: 4 }} />
            <Text style={styles.dateText}>{item.time}</Text>
        </View>
      </View>
      
      <View style={styles.matchTeams}>
        <View style={styles.teamInfo}>
          <Image source={{ uri: item.homeTeam.logo }} style={styles.teamLogo} />
          <Text style={styles.teamText} numberOfLines={1}>{item.homeTeam.name}</Text>
        </View>
        
        <View style={styles.vsContainer}>
          <Text style={styles.vsText}>VS</Text>
        </View>

        <View style={styles.teamInfo}>
          <Image source={{ uri: item.awayTeam.logo }} style={styles.teamLogo} />
          <Text style={styles.teamText} numberOfLines={1}>{item.awayTeam.name}</Text>
        </View>
      </View>
      
      <View style={styles.cardFooter}>
        <Text style={styles.analysisLink}>Match Analysis</Text>
        <Ionicons name="arrow-forward-circle" size={20} color={theme.primary} />
      </View>
    </TouchableOpacity>
  );

  return (
    <View style={styles.container}>
      <ScrollView 
        style={{ flex: 1 }} 
      contentContainerStyle={styles.scrollContent}
      showsVerticalScrollIndicator={false}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.primary} />
      }
    >
      {/* Hero Section */}
      <View style={styles.heroWrapper}>
        <LinearGradient
            colors={isDarkMode ? [theme.primary, theme.bg] : [theme.primary, theme.primary]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.heroSection}
        >
            <View style={styles.patternOverlay} />
            
            {/* Header Row */}
            <View style={styles.headerRow}>
            <View style={styles.logoContainer}>
                <Image source={require('../assets/Logo_A.png')} style={styles.headerLogo} />
            </View>
            
            <TouchableOpacity 
                style={styles.balancePill}
                activeOpacity={0.8}
                onPress={() => navigation.navigate('Market')}
            >
                <LinearGradient
                    colors={['#FFD700', '#FFA500']}
                    start={{x: 0, y: 0}}
                    end={{x: 1, y: 0}}
                    style={styles.balanceGradient}
                >
                    <Ionicons name="wallet" size={moderateScale(14)} color="#000" />
                    <Text style={styles.balanceText}>{formatNumber(balance)} APT</Text>
                    <View style={styles.addBtn}>
                    <Ionicons name="add" size={moderateScale(10)} color="#FFF" />
                    </View>
                </LinearGradient>
            </TouchableOpacity>
            </View>

            <View style={styles.heroContent}>
            <Text style={styles.heroTitle}>DOMINATE</Text>
            <Text style={styles.heroSubtitle}>
                THE MARKET
            </Text>
            <Text style={styles.heroDescription}>
                AI-Powered Precision for Smart Bettors
            </Text>
            
            <TouchableOpacity 
                style={styles.huntButton}
                activeOpacity={0.8}
                onPress={() => navigation.navigate('Tips')}
            >
                <Text style={styles.huntButtonText}>START HUNTING</Text>
                <Ionicons name="arrow-forward" size={moderateScale(20)} color={theme.primary} />
            </TouchableOpacity>
            </View>
        </LinearGradient>

        {/* Leo Entry Card - Floating */}
        <TouchableOpacity 
            style={styles.leoCard}
            onPress={() => navigation.navigate('Leo')}
            activeOpacity={0.9}
        >
            <LinearGradient
                colors={isDarkMode ? ['#1e1e1e', '#2a2a2a'] : [theme.cardBg, theme.cardBg]}
                style={styles.leoGradient}
                start={{x: 0, y: 0}}
                end={{x: 1, y: 1}}
            >
                <View style={styles.leoContent}>
                    <View style={styles.leoIconBox}>
                        <MaterialCommunityIcons name="zodiac-leo" size={24} color="#FFD700" />
                    </View>
                    <View style={styles.leoTextContainer}>
                        <Text style={styles.leoTitle}>Ask Leo AI</Text>
                        <Text style={styles.leoSubtitle}>Get high-confidence predictions</Text>
                    </View>
                    <Ionicons name="chevron-forward" size={24} color={theme.textSecondary} />
                </View>
            </LinearGradient>
        </TouchableOpacity>
      </View>

      {/* Stats Section */}
      <Animated.View style={[styles.statsContainer, { opacity: fadeAnim, transform: [{ translateY: fadeAnim.interpolate({ inputRange: [0, 1], outputRange: [verticalScale(20), 0] }) }] }]}>
        <View style={styles.statBox}>
          <Text style={styles.statNumber}>85%</Text>
          <Text style={styles.statLabel}>Accuracy</Text>
        </View>
        <View style={styles.statDivider} />
        <View style={styles.statBox}>
          <Text style={styles.statNumber}>250+</Text>
          <Text style={styles.statLabel}>Users</Text>
        </View>
        <View style={styles.statDivider} />
        <View style={styles.statBox}>
          <Text style={styles.statNumber}>400%</Text>
          <Text style={styles.statLabel}>ROI</Text>
        </View>
      </Animated.View>

      {/* Live Games Section */}
      {liveMatches.length > 0 && (
        <View style={styles.sectionContainer}>
          <View style={styles.sectionHeader}>
            <View style={styles.sectionTitleRow}>
                <Ionicons name="radio-button-on" size={18} color={theme.error} style={{ marginRight: 8 }} />
                <Text style={styles.sectionTitle}>Live Action</Text>
            </View>
            <TouchableOpacity onPress={() => navigation.navigate('Tips')}>
              <Text style={styles.seeAllText}>See All</Text>
            </TouchableOpacity>
          </View>
          <FlatList
            data={liveMatches}
            renderItem={renderLiveMatchItem}
            keyExtractor={item => item.id}
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.matchesList}
            snapToInterval={CARD_WIDTH + SPACING}
            decelerationRate="fast"
          />
        </View>
      )}

      {/* Upcoming Matches Section */}
      <View style={styles.sectionContainer}>
        <View style={styles.sectionHeader}>
            <View style={styles.sectionTitleRow}>
                <Ionicons name="calendar" size={18} color={theme.primary} style={{ marginRight: 8 }} />
                <Text style={styles.sectionTitle}>Upcoming</Text>
            </View>
        </View>
        
        <View style={styles.filterContainer}>
          {['All', 'Today', 'Tomorrow'].map(filter => (
            <TouchableOpacity
              key={filter}
              style={[
                styles.filterPill, 
                dateFilter === filter && styles.filterPillActive
              ]}
              onPress={() => handleFilterChange(filter)}
            >
              <Text style={[
                styles.filterText, 
                dateFilter === filter && styles.filterTextActive
              ]}>
                {filter}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {loading ? (
          <View style={styles.loaderContainer}>
            <ActivityIndicator size="large" color={theme.primary} />
            <Text style={styles.loadingText}>Analyzing market data...</Text>
          </View>
        ) : upcomingMatches.length > 0 ? (
          <FlatList
            data={upcomingMatches}
            renderItem={renderMatchItem}
            keyExtractor={item => item.id}
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.matchesList}
            snapToInterval={CARD_WIDTH + SPACING}
            decelerationRate="fast"
          />
        ) : (
          <View style={styles.emptyState}>
            <Ionicons name="football-outline" size={moderateScale(48)} color={theme.textSecondary} style={{ opacity: 0.3 }} />
            <Text style={styles.noMatchesText}>No matches scheduled.</Text>
          </View>
        )}
      </View>
      </ScrollView>
      <GlobalBannerAd />
    </View>
  );
}

const createStyles = (theme, isDarkMode) => StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.bg,
  },
  scrollContent: {
    flexGrow: 1,
    paddingBottom: verticalScale(100),
  },
  heroWrapper: {
    marginBottom: verticalScale(50), // Increased to fully clear Leo Card
    position: 'relative',
    zIndex: 1,
  },
  heroSection: {
    paddingTop: Platform.OS === 'ios' ? verticalScale(50) : verticalScale(60),
    paddingBottom: verticalScale(60),
    paddingHorizontal: moderateScale(20),
    borderBottomLeftRadius: moderateScale(35),
    borderBottomRightRadius: moderateScale(35),
    position: 'relative',
    overflow: 'hidden',
  },
  patternOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.1)',
    // In a real app, you might add an ImageBackground with a pattern here
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: verticalScale(30),
  },
  logoContainer: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  headerLogo: {
    width: horizontalScale(120),
    height: horizontalScale(80),
    resizeMode: 'contain',
    marginLeft: horizontalScale(-20),
  },
  balancePill: {
    borderRadius: moderateScale(20),
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
    elevation: 5,
  },
  balanceGradient: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: verticalScale(6),
      paddingHorizontal: horizontalScale(12),
      borderRadius: moderateScale(20),
  },
  balanceText: {
    color: '#000',
    fontWeight: '800',
    fontSize: getResponsiveFontSize(13),
    marginLeft: horizontalScale(6),
    marginRight: horizontalScale(8),
  },
  addBtn: {
    backgroundColor: '#000',
    borderRadius: moderateScale(8),
    width: horizontalScale(16),
    height: horizontalScale(16),
    justifyContent: 'center',
    alignItems: 'center',
  },
  heroContent: {
    marginBottom: verticalScale(20),
    alignItems: 'center',
  },
  heroTitle: {
    fontSize: getResponsiveFontSize(42),
    fontWeight: '900',
    color: theme.white,
    letterSpacing: 1,
    lineHeight: verticalScale(46),
    textAlign: 'center',
  },
  heroSubtitle: {
    fontSize: getResponsiveFontSize(32),
    fontWeight: '300',
    color: '#EBD5AB', // Bright accent color for visibility on primary background
    letterSpacing: 2,
    marginBottom: verticalScale(10),
    textAlign: 'center',
  },
  heroDescription: {
    fontSize: getResponsiveFontSize(14),
    color: 'rgba(255, 255, 255, 0.7)',
    marginBottom: verticalScale(24),
    maxWidth: '80%',
    textAlign: 'center',
  },
  huntButton: {
    flexDirection: 'row',
    backgroundColor: theme.white,
    paddingVertical: verticalScale(14),
    paddingHorizontal: horizontalScale(24),
    borderRadius: moderateScale(16),
    alignItems: 'center',
    alignSelf: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: verticalScale(4) },
    shadowOpacity: 0.3,
    shadowRadius: moderateScale(8),
    elevation: 8,
  },
  huntButtonText: {
    color: theme.primary,
    fontSize: getResponsiveFontSize(15),
    fontWeight: '900',
    letterSpacing: 1,
    marginRight: horizontalScale(8),
  },
  leoCard: {
    position: 'absolute',
    bottom: verticalScale(-35),
    left: moderateScale(20),
    right: moderateScale(20),
    borderRadius: moderateScale(20),
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.4,
    shadowRadius: 12,
    elevation: 10,
  },
  leoGradient: {
    borderRadius: moderateScale(20),
    padding: moderateScale(4), // Border effect
    borderWidth: 1,
    borderColor: 'rgba(255,215,0,0.3)',
  },
  leoContent: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.cardBg,
    borderRadius: moderateScale(17),
    padding: moderateScale(16),
  },
  leoIconBox: {
    width: horizontalScale(44),
    height: horizontalScale(44),
    borderRadius: moderateScale(12),
    backgroundColor: 'rgba(255,215,0,0.1)',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: horizontalScale(16),
  },
  leoTextContainer: {
    flex: 1,
  },
  leoTitle: {
    color: theme.text,
    fontSize: getResponsiveFontSize(16),
    fontWeight: 'bold',
    marginBottom: verticalScale(2),
  },
  leoSubtitle: {
    color: theme.textSecondary,
    fontSize: getResponsiveFontSize(12),
  },
  statsContainer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: moderateScale(20),
    marginBottom: verticalScale(24),
    marginTop: verticalScale(20), 
  },
  statBox: {
    alignItems: 'center',
    backgroundColor: theme.cardBg,
    padding: moderateScale(16),
    borderRadius: moderateScale(16),
    flex: 1,
    borderWidth: 1,
    borderColor: theme.border,
  },
  statDivider: {
    width: horizontalScale(10),
  },
  statNumber: {
    fontSize: getResponsiveFontSize(20),
    fontWeight: 'bold',
    color: theme.primary,
    marginBottom: verticalScale(4),
  },
  statLabel: {
    fontSize: getResponsiveFontSize(12),
    color: theme.textSecondary,
    fontWeight: '500',
  },
  sectionContainer: {
    marginBottom: verticalScale(24),
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: moderateScale(20),
    marginBottom: verticalScale(16),
  },
  sectionTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  sectionTitle: {
    fontSize: getResponsiveFontSize(18),
    fontWeight: 'bold',
    color: theme.text,
  },
  seeAllText: {
    color: theme.primary,
    fontSize: getResponsiveFontSize(14),
    fontWeight: '600',
  },
  matchesList: {
    paddingHorizontal: moderateScale(20),
    paddingBottom: verticalScale(10),
  },
  matchCard: {
    backgroundColor: theme.cardBg,
    borderRadius: moderateScale(20),
    padding: moderateScale(16),
    marginRight: SPACING,
    width: CARD_WIDTH,
    borderWidth: 1,
    borderColor: theme.border,
  },
  liveMatchCard: {
    backgroundColor: theme.cardBg,
    borderRadius: moderateScale(20),
    padding: moderateScale(16),
    marginRight: SPACING,
    width: CARD_WIDTH,
    borderWidth: 1,
    borderColor: theme.error,
    overflow: 'hidden',
  },
  cardGradient: {
      ...StyleSheet.absoluteFillObject,
  },
  cardHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: verticalScale(16),
  },
  leagueBadge: {
    backgroundColor: isDarkMode ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0,0,0,0.05)',
    paddingHorizontal: horizontalScale(10),
    paddingVertical: verticalScale(4),
    borderRadius: moderateScale(8),
    maxWidth: '60%',
  },
  leagueBadgeText: {
    color: theme.textSecondary,
    fontSize: getResponsiveFontSize(11),
    fontWeight: '600',
  },
  timeBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: isDarkMode ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)',
    paddingHorizontal: horizontalScale(8),
    paddingVertical: verticalScale(4),
    borderRadius: moderateScale(8),
  },
  dateText: {
    color: theme.textSecondary,
    fontSize: getResponsiveFontSize(11),
    fontWeight: '500',
  },
  matchTeams: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: verticalScale(20),
  },
  teamInfo: {
    alignItems: 'center',
    width: '35%',
  },
  teamLogo: {
    width: horizontalScale(48),
    height: horizontalScale(48),
    marginBottom: verticalScale(8),
    resizeMode: 'contain',
  },
  teamText: {
    color: theme.text,
    fontSize: getResponsiveFontSize(13),
    fontWeight: 'bold',
    textAlign: 'center',
  },
  vsContainer: {
    width: '30%',
    alignItems: 'center',
  },
  vsText: {
    color: theme.textSecondary,
    fontSize: getResponsiveFontSize(14),
    fontWeight: '900',
    opacity: 0.5,
  },
  cardFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderTopWidth: 1,
    borderTopColor: theme.border,
    paddingTop: verticalScale(12),
  },
  analysisLink: {
    color: theme.primary,
    fontSize: getResponsiveFontSize(13),
    fontWeight: '600',
  },
  liveHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: verticalScale(16),
  },
  liveBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255, 68, 68, 0.2)',
    paddingHorizontal: horizontalScale(8),
    paddingVertical: verticalScale(4),
    borderRadius: moderateScale(8),
  },
  liveDot: {
    width: horizontalScale(6),
    height: horizontalScale(6),
    borderRadius: moderateScale(3),
    backgroundColor: theme.error,
    marginRight: horizontalScale(6),
  },
  liveText: {
    color: theme.error,
    fontSize: getResponsiveFontSize(11),
    fontWeight: 'bold',
  },
  liveScoreContainer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  liveTeam: {
    alignItems: 'center',
    width: '35%',
  },
  liveLogo: {
    width: horizontalScale(40),
    height: horizontalScale(40),
    marginBottom: verticalScale(8),
    resizeMode: 'contain',
  },
  liveTeamName: {
    color: theme.text,
    fontSize: getResponsiveFontSize(12),
    fontWeight: '600',
    textAlign: 'center',
  },
  scoreBox: {
    alignItems: 'center',
    width: '30%',
  },
  scoreText: {
    color: theme.text,
    fontSize: getResponsiveFontSize(20),
    fontWeight: 'bold',
    marginBottom: verticalScale(4),
  },
  liveTime: {
    color: theme.error,
    fontSize: getResponsiveFontSize(11),
    fontWeight: '600',
  },
  filterContainer: {
    flexDirection: 'row',
    paddingHorizontal: moderateScale(20),
    marginBottom: verticalScale(16),
  },
  filterPill: {
    paddingHorizontal: horizontalScale(16),
    paddingVertical: verticalScale(8),
    backgroundColor: theme.cardBg,
    borderRadius: moderateScale(20),
    marginRight: horizontalScale(8),
    borderWidth: 1,
    borderColor: theme.border,
  },
  filterPillActive: {
    backgroundColor: theme.primary,
    borderColor: theme.primary,
  },
  filterText: {
    color: theme.textSecondary,
    fontSize: getResponsiveFontSize(13),
    fontWeight: '600',
  },
  filterTextActive: {
    color: '#000',
    fontWeight: 'bold',
  },
  loaderContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: moderateScale(40),
  },
  loadingText: {
    color: theme.textSecondary,
    marginTop: verticalScale(12),
    fontSize: getResponsiveFontSize(14),
  },
  emptyState: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: moderateScale(40),
    backgroundColor: theme.cardBg,
    marginHorizontal: moderateScale(20),
    borderRadius: moderateScale(20),
    borderWidth: 1,
    borderColor: theme.border,
    borderStyle: 'dashed',
  },
  noMatchesText: {
    color: theme.textSecondary,
    marginTop: verticalScale(16),
    fontSize: getResponsiveFontSize(14),
    fontWeight: '500',
  },
});
