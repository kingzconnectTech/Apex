import React, { useState, useEffect, useRef } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, ScrollView, Image, ActivityIndicator, Animated, Platform, StatusBar, RefreshControl } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import DateTimePicker from '@react-native-community/datetimepicker';
import { LinearGradient } from 'expo-linear-gradient';
import { fetchMatches } from '../services/espn';
import { horizontalScale, verticalScale, moderateScale, getResponsiveFontSize, width } from '../utils/responsive';
import { GlobalBannerAd } from '../components/GlobalBannerAd';
import { useTheme } from '../context/ThemeContext';

const CATEGORIES = ['Football', 'Basketball', 'Tennis'];

const LEAGUES_FILTER = {
  Football: ['Live', 'All', 'Premier League', 'Championship', 'League One', 'La Liga', 'La Liga 2', 'Serie A', 'Serie B', 'Bundesliga', '2. Bundesliga', 'Ligue 1', 'Ligue 2', 'Eredivisie', 'Liga Portugal', 'Liga Portugal 2', 'Super Lig', 'Liga MX', 'Liga de Expansión MX', 'Brasileirão Série A', 'Brasileirão Série B', 'Libertadores', 'Copa Sudamericana', 'Champions League', 'Europa League', 'Europa Conference League', 'MLS', 'NWSL', 'USL Championship', 'International'],
  Basketball: ['Live', 'All', 'NBA', 'WNBA', 'NCAA Men', 'NCAA Women', 'NBA G League', 'EuroLeague', 'EuroCup', 'FIBA EuroBasket', 'FIBA Basketball World Cup', 'NBL Australia', 'NBA Summer League'],
  Tennis: ['Live', 'All', 'Grand Slams', 'ATP Tour', 'ATP Masters 1000', 'ATP 500', 'ATP 250', 'ATP Challenger Tour', 'ATP Finals', 'WTA Tour', 'WTA Premier', 'WTA 1000', 'WTA 500', 'WTA 250', 'WTA Finals']
};

export default function TipsScreen({ navigation }) {
  const { theme, isDarkMode } = useTheme();
  const styles = createStyles(theme, isDarkMode);
  
  const [selectedCategory, setSelectedCategory] = useState('Football');
  const [selectedLeague, setSelectedLeague] = useState('All');
  const [dateFilter, setDateFilter] = useState(new Date());
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [allMatches, setAllMatches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  
  // Animation for loading
  const fadeAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    loadMatches(dateFilter);
  }, [dateFilter]);

  const onRefresh = () => {
    setRefreshing(true);
    loadMatches(dateFilter, true);
  };

  const [visibleMatchesCount, setVisibleMatchesCount] = useState(10);

  const loadMatches = async (date, isRefreshing = false) => {
    if (!isRefreshing) setLoading(true);
    setVisibleMatchesCount(10); // Reset visible count on date change
    Animated.timing(fadeAnim, { toValue: 0, duration: 300, useNativeDriver: true }).start();
    
    try {
      const { live, all } = await fetchMatches(1, date);
      const targetDateStr = date.toDateString();
      const dateMatches = all.filter(m => new Date(m.date).toDateString() === targetDateStr);
      const allMatchesWithLive = [...live, ...dateMatches.filter(m => m.status !== 'in')];
      setAllMatches(allMatchesWithLive);
      
      Animated.timing(fadeAnim, { toValue: 1, duration: 800, useNativeDriver: true }).start();
    } catch (error) {
      console.error("Error loading matches:", error);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const loadMoreTips = () => {
    if (visibleMatchesCount < filteredTips.length) {
      setVisibleMatchesCount(prev => prev + 10);
    }
  };

  // Generate dates for the strip (last 2 days + next 5 days)
  const generateDates = () => {
    const dates = [];
    const today = new Date();
    for (let i = -2; i <= 5; i++) {
      const d = new Date(today);
      d.setDate(today.getDate() + i);
      dates.push(d);
    }
    return dates;
  };

  const datesList = generateDates();

  const getFilteredMatches = () => {
    return allMatches.filter(match => {
      let matchSport;
      if (match.sport === 'soccer') matchSport = 'Football';
      else if (match.sport === 'basketball') matchSport = 'Basketball';
      else if (match.sport === 'tennis') matchSport = 'Tennis';
      else matchSport = match.sport;
      
      if (matchSport !== selectedCategory) return false;
      
      if (selectedLeague === 'Live') {
        if (match.status !== 'in') return false;
      } else if (selectedLeague !== 'All') {
        if (selectedLeague === 'International' && selectedCategory === 'Football') {
          const internationalLeagues = ['International Friendlies', 'Nations League', 'Euros', 'World Cup', "Women's World Cup", 'Copa America', 'Gold Cup'];
          if (!internationalLeagues.includes(match.league)) return false;
        } else if (match.league !== selectedLeague) {
          return false;
        }
      }
      
      return true;
    }).sort((a, b) => {
      return a.status === 'in' ? -1 : 1;
    });
  };

  const onDateChange = (event, selectedDate) => {
    setShowDatePicker(false);
    if (selectedDate) setDateFilter(selectedDate);
  };

  const renderTipCard = ({ item, index }) => {
    return (
      <Animated.View style={{ opacity: fadeAnim, transform: [{ translateY: fadeAnim.interpolate({ inputRange: [0, 1], outputRange: [50, 0] }) }] }}>
        <TouchableOpacity 
          style={[styles.cardContainer, item.status === 'in' && styles.cardContainerLive]}
          activeOpacity={0.8}
          onPress={() => navigation.navigate('MatchDetails', { match: item })}
        >
          {item.status === 'in' && (
            <LinearGradient
              colors={['rgba(255, 68, 68, 0.1)', 'transparent']}
              style={styles.cardGradient}
            />
          )}
          <View style={styles.cardContent}>
              {/* Header: League & Time */}
              <View style={styles.cardHeader}>
                  <View style={styles.leagueBadge}>
                    <Text style={styles.leagueName} numberOfLines={1}>{item.league}</Text>
                  </View>
                  <View style={[styles.statusBadge, item.status === 'in' && styles.statusLive]}>
                    <Text style={[styles.statusText, item.status === 'in' && styles.statusTextLive]}>
                        {item.status === 'in' ? 'LIVE' : item.time}
                    </Text>
                  </View>
              </View>

              {/* Teams Section */}
              <View style={styles.teamsRow}>
                  <View style={styles.teamWrapper}>
                      <Image source={{ uri: item.homeTeam.logo }} style={styles.teamLogo} />
                      <Text style={styles.teamName} numberOfLines={2}>{item.homeTeam.name}</Text>
                  </View>
                  
                  <View style={styles.vsWrapper}>
                    {item.status === 'in' ? (
                      <Text style={[styles.scoreText, {fontSize: getResponsiveFontSize(18)}]}>
                        {item.homeTeam.score} - {item.awayTeam.score}
                      </Text>
                    ) : (
                      <Text style={styles.vsText}>VS</Text>
                    )}
                  </View>

                  <View style={styles.teamWrapper}>
                      <Image source={{ uri: item.awayTeam.logo }} style={styles.teamLogo} />
                      <Text style={styles.teamName} numberOfLines={2}>{item.awayTeam.name}</Text>
                  </View>
              </View>

              {/* Footer: Action */}
              <View style={styles.cardFooter}>
                  <Text style={styles.footerText}>AI Analysis Available</Text>
                  <Ionicons name="chevron-forward-circle" size={20} color={theme.primary} />
              </View>
          </View>
        </TouchableOpacity>
      </Animated.View>
    );
  };

  const filteredTips = getFilteredMatches();

  return (
    <View style={styles.container}>
      <StatusBar barStyle={isDarkMode ? "light-content" : "dark-content"} />
      
      {/* Header Section */}
      <SafeAreaView edges={['top']} style={styles.safeArea}>
        <View style={styles.headerContainer}>
            <View>
                <Text style={styles.headerTitle}>Apex Tips</Text>
                <Text style={styles.headerSubtitle}>Daily AI Predictions</Text>
            </View>
            <TouchableOpacity style={styles.calendarBtn} onPress={() => setShowDatePicker(true)}>
                <Ionicons name="calendar-outline" size={24} color={theme.text} />
            </TouchableOpacity>
        </View>

        {/* Date Strip */}
        <View style={styles.dateStripContainer}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.dateScrollContent}>
                {datesList.map((date, index) => {
                    const isSelected = date.toDateString() === dateFilter.toDateString();
                    const isToday = date.toDateString() === new Date().toDateString();
                    const dayName = isToday ? 'TODAY' : date.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase();
                    const dayNum = date.getDate();
                    
                    return (
                        <TouchableOpacity 
                            key={index} 
                            style={[styles.dateItem, isSelected && styles.dateItemActive]}
                            onPress={() => setDateFilter(date)}
                        >
                            <Text style={[styles.dateDay, isSelected && styles.dateDayActive]}>{dayName}</Text>
                            <Text style={[styles.dateNum, isSelected && styles.dateNumActive]}>{dayNum}</Text>
                        </TouchableOpacity>
                    );
                })}
            </ScrollView>
        </View>

        {/* Filters */}
        <View style={styles.filtersSection}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.categoryScroll}>
                {CATEGORIES.map(cat => (
                    <TouchableOpacity 
                        key={cat} 
                        style={[styles.catPill, selectedCategory === cat && styles.catPillActive]}
                        onPress={() => { setSelectedCategory(cat); setSelectedLeague('All'); }}
                    >
                        <Text style={[styles.catText, selectedCategory === cat && styles.catTextActive]}>{cat}</Text>
                    </TouchableOpacity>
                ))}
                <View style={styles.verticalDivider} />
                {LEAGUES_FILTER[selectedCategory].map(league => (
                    <TouchableOpacity 
                        key={league} 
                        style={[styles.leaguePill, selectedLeague === league && styles.leaguePillActive]}
                        onPress={() => setSelectedLeague(league)}
                    >
                        <Text style={[styles.leagueTextFilter, selectedLeague === league && styles.leagueTextActive]}>{league}</Text>
                    </TouchableOpacity>
                ))}
            </ScrollView>
        </View>
      </SafeAreaView>

      {/* Main List */}
      {loading ? (
        <View style={styles.centerContainer}>
            <ActivityIndicator size="large" color={theme.primary} />
            <Text style={styles.loadingText}>Finding best matches...</Text>
        </View>
      ) : (
        <FlatList
            data={filteredTips.slice(0, visibleMatchesCount)}
            renderItem={renderTipCard}
            keyExtractor={item => item.id}
            contentContainerStyle={styles.listContainer}
            showsVerticalScrollIndicator={false}
            initialNumToRender={5}
            maxToRenderPerBatch={10}
            windowSize={5}
            onEndReached={loadMoreTips}
            onEndReachedThreshold={0.5}
            refreshControl={
              <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.primary} colors={[theme.primary]} />
            }
            ListEmptyComponent={
                <View style={styles.emptyState}>
                    <Ionicons name="stats-chart-outline" size={60} color={theme.textSecondary} style={{ opacity: 0.3 }} />
                    <Text style={styles.emptyText}>No matches scheduled.</Text>
                </View>
            }
            ListFooterComponent={
              visibleMatchesCount < filteredTips.length ? (
                <View style={{ paddingVertical: 20 }}>
                  <ActivityIndicator color={theme.primary} />
                </View>
              ) : null
            }
        />
      )}

      {showDatePicker && (
        <DateTimePicker
          value={dateFilter}
          mode="date"
          display="default"
          onChange={onDateChange}
        />
      )}
      <GlobalBannerAd />
    </View>
  );
}

const createStyles = (theme, isDarkMode) => StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.bg,
  },
  safeArea: {
    backgroundColor: theme.bg,
    paddingBottom: verticalScale(10),
  },
  headerContainer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: moderateScale(20),
    paddingTop: verticalScale(10),
    marginBottom: verticalScale(20),
  },
  headerTitle: {
    fontSize: getResponsiveFontSize(32),
    fontWeight: '800',
    color: theme.text,
    letterSpacing: -0.5,
  },
  headerSubtitle: {
    fontSize: getResponsiveFontSize(14),
    color: theme.textSecondary,
    fontWeight: '500',
  },
  calendarBtn: {
    padding: moderateScale(10),
    backgroundColor: theme.cardBg,
    borderRadius: moderateScale(12),
  },
  dateStripContainer: {
    marginBottom: verticalScale(15),
  },
  dateScrollContent: {
    paddingHorizontal: moderateScale(20),
  },
  dateItem: {
    width: horizontalScale(55),
    height: verticalScale(70),
    backgroundColor: theme.cardBg,
    borderRadius: moderateScale(16),
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: horizontalScale(10),
    borderWidth: 1,
    borderColor: theme.border,
  },
  dateItemActive: {
    backgroundColor: theme.primary,
    borderColor: theme.primary,
    transform: [{ scale: 1.05 }],
  },
  dateDay: {
    fontSize: getResponsiveFontSize(11),
    color: theme.textSecondary,
    marginBottom: verticalScale(4),
    fontWeight: '600',
  },
  dateDayActive: {
    color: 'rgba(255,255,255,0.8)',
  },
  dateNum: {
    fontSize: getResponsiveFontSize(20),
    fontWeight: '700',
    color: theme.text,
  },
  dateNumActive: {
    color: '#FFFFFF',
  },
  filtersSection: {
    marginBottom: verticalScale(5),
  },
  categoryScroll: {
    paddingHorizontal: moderateScale(20),
    alignItems: 'center',
  },
  catPill: {
    paddingHorizontal: horizontalScale(16),
    paddingVertical: verticalScale(8),
    borderRadius: moderateScale(20),
    marginRight: horizontalScale(8),
    backgroundColor: theme.cardBg,
  },
  catPillActive: {
    backgroundColor: theme.text, // Invert for active
  },
  catText: {
    color: theme.textSecondary,
    fontWeight: '600',
    fontSize: getResponsiveFontSize(13),
  },
  catTextActive: {
    color: theme.bg,
    fontWeight: '700',
  },
  verticalDivider: {
    width: 1,
    height: verticalScale(16),
    backgroundColor: theme.border,
    marginHorizontal: horizontalScale(10),
  },
  leaguePill: {
    paddingHorizontal: horizontalScale(12),
    paddingVertical: verticalScale(6),
    borderRadius: moderateScale(12),
    marginRight: horizontalScale(6),
    borderWidth: 1,
    borderColor: theme.border,
  },
  leaguePillActive: {
    borderColor: theme.primary,
    backgroundColor: isDarkMode ? 'rgba(52, 152, 219, 0.15)' : 'rgba(52, 152, 219, 0.05)', // transparent primary
  },
  leagueTextFilter: {
    color: theme.textSecondary,
    fontSize: getResponsiveFontSize(12),
  },
  leagueTextActive: {
    color: theme.primary,
    fontWeight: '600',
  },
  listContainer: {
    paddingHorizontal: moderateScale(20),
    paddingBottom: verticalScale(100),
    paddingTop: verticalScale(10),
  },
  cardContainer: {
    backgroundColor: theme.cardBg,
    borderRadius: moderateScale(24),
    marginBottom: verticalScale(20),
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: theme.border,
  },
  cardContainerLive: {
    borderColor: theme.error,
  },
  cardGradient: {
      ...StyleSheet.absoluteFillObject,
  },
  scoreText: {
    color: theme.text,
    fontWeight: 'bold',
  },
  cardContent: {
    padding: moderateScale(20),
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: verticalScale(20),
  },
  leagueBadge: {
    backgroundColor: isDarkMode ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)',
    paddingHorizontal: horizontalScale(10),
    paddingVertical: verticalScale(4),
    borderRadius: moderateScale(8),
  },
  leagueName: {
    color: theme.textSecondary,
    fontSize: getResponsiveFontSize(12),
    fontWeight: '600',
    textTransform: 'uppercase',
  },
  statusBadge: {
    backgroundColor: isDarkMode ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)',
    paddingHorizontal: horizontalScale(10),
    paddingVertical: verticalScale(4),
    borderRadius: moderateScale(8),
  },
  statusLive: {
    backgroundColor: 'rgba(231, 76, 60, 0.2)',
  },
  statusText: {
    color: theme.text,
    fontSize: getResponsiveFontSize(12),
    fontWeight: '700',
  },
  statusTextLive: {
    color: '#FF6B6B',
  },
  teamsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: verticalScale(20),
  },
  teamWrapper: {
    flex: 1,
    alignItems: 'center',
  },
  teamLogo: {
    width: horizontalScale(50),
    height: horizontalScale(50),
    resizeMode: 'contain',
    marginBottom: verticalScale(10),
  },
  teamName: {
    color: theme.text,
    fontSize: getResponsiveFontSize(14),
    fontWeight: '600',
    textAlign: 'center',
    lineHeight: verticalScale(18),
  },
  vsWrapper: {
    width: horizontalScale(40),
    alignItems: 'center',
    justifyContent: 'center',
  },
  vsText: {
    color: theme.textSecondary,
    fontSize: getResponsiveFontSize(24),
    fontWeight: '900',
    fontStyle: 'italic',
    opacity: 0.5,
  },
  cardFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderTopWidth: 1,
    borderTopColor: theme.border,
    paddingTop: verticalScale(15),
  },
  footerText: {
    color: theme.primary,
    fontSize: getResponsiveFontSize(13),
    fontWeight: '600',
  },
  centerContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    marginTop: verticalScale(10),
    color: theme.textSecondary,
    fontSize: getResponsiveFontSize(14),
  },
  emptyState: {
    alignItems: 'center',
    marginTop: verticalScale(50),
    opacity: 0.5,
  },
  emptyText: {
    color: theme.textSecondary,
    fontSize: getResponsiveFontSize(16),
    marginTop: verticalScale(10),
    fontWeight: '500',
  },
});
