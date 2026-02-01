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

const CATEGORIES = ['Football', 'Basketball'];

const LEAGUES_FILTER = {
  Football: ['All', 'Premier League', 'La Liga', 'Serie A', 'Bundesliga', 'Ligue 1', 'Eredivisie', 'Championship', 'Liga Portugal', 'Super Lig', 'Liga MX', 'Brasileirão', 'Libertadores', 'Champions League', 'Europa League', 'MLS', 'International'],
  Basketball: ['All', 'NBA', 'WNBA', 'NCAA Men', 'NBA G League']
};

export default function TipsScreen({ navigation }) {
  const { theme, isDarkMode } = useTheme();
  const styles = createStyles(theme, isDarkMode);
  
  const [selectedCategory, setSelectedCategory] = useState('Football');
  const [selectedLeague, setSelectedLeague] = useState('All');
  const [dateFilter, setDateFilter] = useState(new Date());
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [matches, setMatches] = useState([]);
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

  const loadMatches = async (date, isRefreshing = false) => {
    if (!isRefreshing) setLoading(true);
    Animated.timing(fadeAnim, { toValue: 0, duration: 300, useNativeDriver: true }).start();
    
    try {
      const { all } = await fetchMatches(1, date);
      const targetDateStr = date.toDateString();
      const dateMatches = all.filter(m => new Date(m.date).toDateString() === targetDateStr);
      setMatches(dateMatches);
      
      Animated.timing(fadeAnim, { toValue: 1, duration: 800, useNativeDriver: true }).start();
    } catch (error) {
      console.error("Error loading matches:", error);
    } finally {
      setLoading(false);
      setRefreshing(false);
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
    return matches.filter(match => {
      const matchSport = match.sport === 'soccer' ? 'Football' : 'Basketball';
      if (matchSport !== selectedCategory) return false;
      if (selectedLeague !== 'All' && match.league !== selectedLeague) return false;
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
          style={styles.cardContainer}
          activeOpacity={0.8}
          onPress={() => navigation.navigate('MatchDetails', { match: item })}
        >
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
                      <Text style={styles.vsText}>VS</Text>
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
            data={filteredTips}
            renderItem={renderTipCard}
            keyExtractor={item => item.id}
            contentContainerStyle={styles.listContainer}
            showsVerticalScrollIndicator={false}
            refreshControl={
              <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.primary} colors={[theme.primary]} />
            }
            ListEmptyComponent={
                <View style={styles.emptyState}>
                    <Ionicons name="stats-chart-outline" size={60} color={theme.textSecondary} style={{ opacity: 0.3 }} />
                    <Text style={styles.emptyText}>No matches scheduled.</Text>
                </View>
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
