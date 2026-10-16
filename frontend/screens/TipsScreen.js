import React, { useState, useEffect, useRef, useMemo } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, ScrollView, Image, ActivityIndicator, Animated, Platform, StatusBar, RefreshControl, Modal, TextInput } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import DateTimePicker from '@react-native-community/datetimepicker';
import { LinearGradient } from 'expo-linear-gradient';
import { fetchMatches, fetchLeagueMatches } from '../services/espn';
import { fetchSportsDataLeagues, fetchRecommendedPredictions, fetchBasketballPredictions } from '../services/api';
import { PITCHAPI_77_LEAGUES, PITCHAPI_LEAGUE_NAMES } from '../constants/pitchapiLeagues';
import { horizontalScale, verticalScale, moderateScale, getResponsiveFontSize, width } from '../utils/responsive';
import { GlobalBannerAd } from '../components/GlobalBannerAd';
import BasketballGameCard from '../components/BasketballGameCard';
import { useTheme } from '../context/ThemeContext';

const CATEGORIES = ['Football', 'Basketball', 'Tennis'];

const toSnake = (obj) => {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(toSnake);
  const out = {};
  for (const k of Object.keys(obj)) {
    const snake = k.replace(/([A-Z])/g, '_$1').toLowerCase();
    out[snake] = toSnake(obj[k]);
  }
  return out;
};

const REGIONS = ['All (77)', 'Europe', 'Americas', 'Asia', 'Middle East & Africa'];

const LEAGUES_FILTER = {
  Football: ['Live', 'All', ...PITCHAPI_LEAGUE_NAMES],
  Basketball: ['Live', 'All', 'NBA', 'WNBA', 'NCAA Men', 'NCAA Women', 'NBA G League', 'EuroLeague', 'EuroCup', 'FIBA EuroBasket', 'FIBA Basketball World Cup', 'NBL Australia', 'NBA Summer League'],
  Tennis: ['Live', 'All', 'Grand Slams', 'ATP Tour', 'ATP Masters 1000', 'ATP 500', 'ATP 250', 'ATP Challenger Tour', 'ATP Finals', 'WTA Tour', 'WTA Premier', 'WTA 1000', 'WTA 500', 'WTA 250', 'WTA Finals']
};

// UI league labels -> backend league keys. Labels with no configured engine
// fall through to null, which lets the API return all configured leagues.
const BASKETBALL_LEAGUE_KEYS = {
  NBA: 'nba',
  WNBA: 'wnba',
  'NCAA Men': 'ncaa',
  'NCAA Women': 'ncaa',
  EuroLeague: 'euroleague',
};

const CONFIDENCE_FILTERS = ['All', 'High', 'Medium', 'Low'];
const MARKET_FILTERS = ['All', 'Total Points', 'Spread'];

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

  // Dedicated Recommended Predictions vs All Fixtures View Mode
  const [activeView, setActiveView] = useState('recommended'); // 'recommended' | 'all_fixtures'
  const [recommendedData, setRecommendedData] = useState({
    recommendations: [],
    totalAnalyzed: 0,
    totalRecommended: 0,
    totalRejected: 0,
    acceptanceRate: 0,
  });
  const [loadingRecommended, setLoadingRecommended] = useState(false);

  // Basketball prediction engine state
  const [basketballPredictions, setBasketballPredictions] = useState([]);
  const [loadingBasketball, setLoadingBasketball] = useState(false);
  const [basketballDisclaimer, setBasketballDisclaimer] = useState(null);
  const [basketballConfidence, setBasketballConfidence] = useState('All');
  const [basketballMarket, setBasketballMarket] = useState('All');

  // 77 Leagues Directory State
  const [leaguesCatalog, setLeaguesCatalog] = useState(PITCHAPI_77_LEAGUES);
  const [leagueModalVisible, setLeagueModalVisible] = useState(false);
  const [leagueSearchQuery, setLeagueSearchQuery] = useState('');
  const [selectedRegionTab, setSelectedRegionTab] = useState('All (77)');
  const [fetchingLeagueOnDemand, setFetchingLeagueOnDemand] = useState(false);
  
  // Animation for loading
  const fadeAnim = useRef(new Animated.Value(0)).current;

  // Sync latest leagues dynamically from backend if available
  useEffect(() => {
    let isMounted = true;
    (async () => {
      try {
        const remote = await fetchSportsDataLeagues();
        if (isMounted && Array.isArray(remote) && remote.length > 0) {
          // Merge with local catalog for logos & regions
          const remoteList = remote.map(r => {
            const local = PITCHAPI_77_LEAGUES.find(l => l.sourceId === r.league?.sourceId || l.name === r.league?.name);
            return {
              id: r.league?.id || local?.id,
              sourceId: r.league?.sourceId || local?.sourceId,
              name: r.league?.name || local?.name,
              country: r.league?.country || local?.country || 'INT',
              displayName: local?.displayName || r.league?.name,
              logo: r.league?.logo || local?.logo,
              season: r.league?.season || local?.season,
              region: local?.region || 'Europe',
              isFree: r.isFree !== false,
            };
          });
          setLeaguesCatalog(remoteList);
        }
      } catch (_) {}
    })();
    return () => { isMounted = false; };
  }, []);

  const loadRecommended = async (date) => {
    if (selectedCategory !== 'Football' && selectedCategory !== 'Basketball') return;
    setLoadingRecommended(true);
    try {
      const y = date.getFullYear();
      const m = String(date.getMonth() + 1).padStart(2, '0');
      const d = String(date.getDate()).padStart(2, '0');
      const dateStr = `${y}${m}${d}`;
      const sport = selectedCategory === 'Football' ? 'soccer' : 'basketball';
      const res = await fetchRecommendedPredictions({
        sport,
        date: dateStr,
        league: selectedLeague !== 'All' && selectedLeague !== 'Live' ? selectedLeague : null,
        minProb: 0.75,
      });
      if (res && res.success) {
        const recs = Array.isArray(res.recommended) ? res.recommended.map(toSnake) : [];
        setRecommendedData({
          recommendations: recs,
          totalAnalyzed: res.stats?.totalAnalyzed || res.totalAnalyzed || 0,
          totalRecommended: res.stats?.totalRecommended || res.totalRecommended || 0,
          totalRejected: res.stats?.totalRejected || res.totalRejected || 0,
          acceptanceRate: res.stats?.acceptanceRate || res.acceptanceRate || 0,
        });
      } else {
        setRecommendedData({
          recommendations: [],
          totalAnalyzed: 0,
          totalRecommended: 0,
          totalRejected: 0,
          acceptanceRate: 0,
        });
      }
    } catch (e) {
      console.warn('Error loading recommended predictions:', e);
    } finally {
      setLoadingRecommended(false);
    }
  };

  const loadBasketballPredictions = async (date) => {
    setLoadingBasketball(true);
    try {
      const y = date.getFullYear();
      const m = String(date.getMonth() + 1).padStart(2, '0');
      const d = String(date.getDate()).padStart(2, '0');
      const dateStr = `${y}-${m}-${d}`;
      const leagueKey = BASKETBALL_LEAGUE_KEYS[selectedLeague] || null;
      const res = await fetchBasketballPredictions({
        date: dateStr,
        league: leagueKey,
        confidence: basketballConfidence,
        market: basketballMarket,
      });
      setBasketballPredictions(res.predictions || []);
      setBasketballDisclaimer(res.disclaimer || null);
    } catch (e) {
      console.warn('Error loading basketball predictions:', e);
      setBasketballPredictions([]);
    } finally {
      setLoadingBasketball(false);
    }
  };

  useEffect(() => {
    loadMatches(dateFilter);
    loadRecommended(dateFilter);
  }, [dateFilter, selectedCategory, selectedLeague]);

  useEffect(() => {
    if (selectedCategory !== 'Basketball') return;
    if (activeView !== 'recommended') return;
    loadBasketballPredictions(dateFilter);
  }, [dateFilter, selectedCategory, selectedLeague, activeView, basketballConfidence, basketballMarket]);

  const onRefresh = () => {
    setRefreshing(true);
    loadMatches(dateFilter, true);
    loadRecommended(dateFilter);
    if (selectedCategory === 'Basketball' && activeView === 'recommended') {
      loadBasketballPredictions(dateFilter);
    }
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

  const handleSelectLeague = async (leagueItemOrName) => {
    const leagueName = typeof leagueItemOrName === 'string' ? leagueItemOrName : leagueItemOrName.name;
    const leagueObj = typeof leagueItemOrName === 'object' ? leagueItemOrName : leaguesCatalog.find(l => l.name === leagueName);
    
    setSelectedLeague(leagueName);
    setLeagueModalVisible(false);

    // If matches for this league aren't in allMatches yet, fetch on-demand!
    // (Football only — basketball leagues run through the prediction engine.)
    if (selectedCategory === 'Football' && leagueName !== 'All' && leagueName !== 'Live') {
      const alreadyHas = allMatches.some(m => m.league === leagueName);
      if (!alreadyHas && leagueObj) {
        setFetchingLeagueOnDemand(true);
        try {
          const slug = leagueObj.sourceId || leagueObj.id;
          const newMatches = await fetchLeagueMatches(slug, 'soccer', leagueName);
          if (newMatches && newMatches.length > 0) {
            setAllMatches(prev => {
              const existingIds = new Set(prev.map(m => m.id));
              const fresh = newMatches.filter(m => !existingIds.has(m.id));
              return [...prev, ...fresh];
            });
          }
        } catch (e) {
          console.warn('Failed on-demand league fetch:', e);
        } finally {
          setFetchingLeagueOnDemand(false);
        }
      }
    }
  };

  const filtered77Leagues = useMemo(() => {
    return leaguesCatalog.filter(l => {
      if (selectedRegionTab !== 'All (77)' && l.region !== selectedRegionTab) {
        return false;
      }
      if (!leagueSearchQuery.trim()) return true;
      const q = leagueSearchQuery.trim().toLowerCase();
      return (
        (l.name && l.name.toLowerCase().includes(q)) ||
        (l.country && l.country.toLowerCase().includes(q)) ||
        (l.displayName && l.displayName.toLowerCase().includes(q))
      );
    });
  }, [leaguesCatalog, selectedRegionTab, leagueSearchQuery]);

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
                  <View style={[styles.statusBadge, item.status === 'in' && styles.statusLive, item.status === 'post' && styles.statusFinished]}>
                    <Text style={[styles.statusText, item.status === 'in' && styles.statusTextLive, item.status === 'post' && styles.statusTextFinished]}>
                        {item.status === 'in' ? 'LIVE' : (item.status === 'post' ? 'FT' : item.time)}
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
                    {item.status === 'in' || item.status === 'post' ? (
                      <Text style={[styles.scoreText, {fontSize: getResponsiveFontSize(18), fontWeight: 'bold'}]}>
                        {item.homeTeam.score ?? 0} - {item.awayTeam.score ?? 0}
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
                  <Text style={[styles.footerText, item.status === 'post' && { color: '#10B981', fontWeight: 'bold' }]}>
                    {item.status === 'post' ? 'Settled AI Prediction' : 'AI Analysis Available'}
                  </Text>
                  <Ionicons
                    name={item.status === 'post' ? "checkmark-circle" : "chevron-forward-circle"}
                    size={20}
                    color={item.status === 'post' ? "#10B981" : theme.primary}
                  />
              </View>
          </View>
        </TouchableOpacity>
      </Animated.View>
    );
  };

  const renderRecommendedCard = ({ item }) => {
    const marketKey = item.recommendedMarket || item.market || '';
    const isUnder45 = marketKey === 'under_4_5_goals';
    const isUnder25Ht = marketKey === 'under_2_5_ht';
    const isCorners = marketKey.includes('corners');
    const isBookings = marketKey.includes('bookings');
    const isShots = marketKey.startsWith('total_shots_') || marketKey.startsWith('home_shots_') || marketKey.startsWith('away_shots_') || item.category === 'shots';
    const isBasketball = item.category === 'basketball' || marketKey.startsWith('basketball_');

    const marketDisplayTitle =
      isShots ? (item.label || item.value || item.marketLabel || 'Total Shots Over/Under') :
      isBasketball ? (item.label || item.value || item.marketLabel || 'Basketball Prediction') :
      isUnder45 ? 'Under 4.5 Match Goals' :
      isUnder25Ht ? 'Under 2.5 First Half Goals' :
      isCorners ? (item.label || item.value || item.marketLabel || 'Over/Under Corners') :
      isBookings ? (item.label || item.value || item.marketLabel || 'Over/Under Bookings') :
      item.marketLabel || item.label || 'High Confidence Prediction';

    const formattedKickoff = item.kickoff ? new Date(item.kickoff).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Upcoming';
    const calProb = Math.round((item.calibrated_probability || item.probability || 0.75) * 100);

    // Market-specific supporting stats from the model (never hardcoded)
    const shotsInfo = isShots && (item.expected_total_shots != null || item.expected_home_shots != null)
      ? `Exp. Shots: ${item.expected_total_shots ?? (item.expected_home_shots + item.expected_away_shots)} (H:${item.expected_home_shots ?? '-'} A:${item.expected_away_shots ?? '-'})`
      : null;

    const basketballInfo = isBasketball && (item.expected_home_points != null)
      ? `Exp: ${Math.round(item.expected_home_points)}-${Math.round(item.expected_away_points)} (Total: ${Math.round(item.expected_total_points)}) | Pace: ${Math.round(item.pace || 98)}`
      : null;

    return (
      <Animated.View style={{ opacity: fadeAnim }}>
        <TouchableOpacity
          style={[styles.cardContainer, styles.recommendedCardContainer]}
          activeOpacity={0.85}
          onPress={() => {
            const matchPayload = item.fullFixture || {
              id: item.fixtureId,
              league: item.league,
              sport: item.sport || 'soccer',
              date: item.kickoff,
              time: formattedKickoff,
              status: item.status || 'pre',
              homeTeam: { name: item.homeName, logo: item.homeLogo },
              awayTeam: { name: item.awayName, logo: item.awayLogo },
            };
            navigation.navigate('MatchDetails', { match: matchPayload });
          }}
        >
          <View style={styles.cardContent}>
            {/* Header: League & Calibrated Prob Badge */}
            <View style={styles.cardHeader}>
              <View style={styles.leagueBadge}>
                <Text style={styles.leagueName} numberOfLines={1}>{item.league || 'Football'}</Text>
              </View>
              <View style={styles.validatedBadgeHeader}>
                <Ionicons name="shield-checkmark" size={13} color="#10B981" style={{ marginRight: 4 }} />
                <Text style={styles.validatedBadgeHeaderText}>
                  {calProb}% CALIBRATED
                </Text>
              </View>
            </View>

            {/* Teams Row */}
            <View style={styles.teamsRow}>
              <View style={styles.teamWrapper}>
                {item.homeLogo ? (
                  <Image source={{ uri: item.homeLogo }} style={styles.teamLogo} />
                ) : (
                  <View style={[styles.teamLogo, styles.placeholderLogo]}>
                    <Ionicons name="shield" size={24} color={theme.textSecondary} />
                  </View>
                )}
                <Text style={styles.teamName} numberOfLines={2}>{item.homeName}</Text>
              </View>

              <View style={styles.vsWrapper}>
                <Text style={styles.vsText}>VS</Text>
                <Text style={styles.kickoffTimeText}>{formattedKickoff}</Text>
              </View>

              <View style={styles.teamWrapper}>
                {item.awayLogo ? (
                  <Image source={{ uri: item.awayLogo }} style={styles.teamLogo} />
                ) : (
                  <View style={[styles.teamLogo, styles.placeholderLogo]}>
                    <Ionicons name="shield" size={24} color={theme.textSecondary} />
                  </View>
                )}
                <Text style={styles.teamName} numberOfLines={2}>{item.awayName}</Text>
              </View>
            </View>

            {/* Recommended Prediction Highlight Box */}
            <View style={styles.recMarketBox}>
              <View style={styles.recMarketTopRow}>
                <View style={styles.recMarketTag}>
                  <Text style={styles.recMarketTagText}>QUALIFIED MARKET</Text>
                </View>
                <View style={styles.confidenceLabelPill}>
                  <Text style={styles.confidenceLabelPillText}>{item.confidenceLabel || 'Validated'}</Text>
                </View>
              </View>

              <Text style={styles.recMarketTitle}>{marketDisplayTitle}</Text>
              <Text style={styles.recSelectionText}>
                Recommended Selection: <Text style={{ color: '#10B981', fontWeight: 'bold' }}>{item.recommendedSelection || item.selection || item.value || 'Under 2.5'}</Text>
              </Text>

              {/* Statistical Metrics Row */}
              <View style={styles.metricsRow}>
                <View style={styles.metricItem}>
                  <Text style={styles.metricLabel}>Predictability</Text>
                  <Text style={styles.metricValue}>{Math.round((item.predictability_score || 0.7) * 100)}%</Text>
                </View>
                <View style={styles.metricDivider} />
                <View style={styles.metricItem}>
                  <Text style={styles.metricLabel}>Sample Size</Text>
                  <Text style={styles.metricValue}>{item.sample_size || 10}+ Matches</Text>
                </View>
                <View style={styles.metricDivider} />
                <View style={styles.metricItem}>
                  <Text style={styles.metricLabel}>Data Quality</Text>
                  <Text style={styles.metricValue}>{Math.round((item.data_quality_score || 0.8) * 100)}%</Text>
                </View>
              </View>
            </View>

            {/* Supporting Evidence Bullets */}
            {(shotsInfo || basketballInfo || (Array.isArray(item.supporting_evidence) && item.supporting_evidence.length > 0)) && (
              <View style={styles.evidenceContainer}>
                <Text style={styles.evidenceHeading}>Supporting Statistical Evidence:</Text>
                {shotsInfo && (
                  <View style={styles.evidenceBulletRow}>
                    <Ionicons name="analytics" size={14} color="#00F2FE" style={{ marginRight: 6, marginTop: 2 }} />
                    <Text style={styles.evidenceBulletText}>{shotsInfo}</Text>
                  </View>
                )}
                {basketballInfo && (
                  <View style={styles.evidenceBulletRow}>
                    <Ionicons name="basketball" size={14} color="#FF6B6B" style={{ marginRight: 6, marginTop: 2 }} />
                    <Text style={styles.evidenceBulletText}>{basketballInfo}</Text>
                  </View>
                )}
                {Array.isArray(item.supporting_evidence) && item.supporting_evidence.slice(0, 3).map((bullet, bIdx) => (
                  <View key={bIdx} style={styles.evidenceBulletRow}>
                    <Ionicons name="checkmark-circle" size={14} color="#10B981" style={{ marginRight: 6, marginTop: 2 }} />
                    <Text style={styles.evidenceBulletText}>{bullet}</Text>
                  </View>
                ))}
              </View>
            )}

            {/* Footer */}
            <View style={styles.cardFooter}>
              <Text style={styles.footerText}>Tap to View In-Depth Match Analytics</Text>
              <Ionicons name="chevron-forward-circle" size={20} color={theme.primary} />
            </View>
          </View>
        </TouchableOpacity>
      </Animated.View>
    );
  };

  const renderRecommendedEmptyState = () => {
    return (
      <View style={styles.strictEmptyContainer}>
        <View style={styles.strictEmptyIconCircle}>
          <Ionicons name="shield-outline" size={48} color="#00F2FE" />
        </View>
        <Text style={styles.strictEmptyTitle}>Strict Quality Filter Active</Text>
        <Text style={styles.strictEmptyDesc}>
          {recommendedData.totalAnalyzed > 0
            ? `Analyzed ${recommendedData.totalAnalyzed} upcoming fixtures. None passed our strict 75%+ calibrated probability and data quality requirements today.`
            : 'No upcoming fixtures currently meet our strict 75%+ calibrated probability, data quality, and sample size criteria.'}
        </Text>
        <Text style={styles.strictEmptySubtext}>
          Apex protects prediction reliability by abstaining when historical evidence is volatile or insufficient, rather than predicting every game.
        </Text>
        <TouchableOpacity
          style={styles.browseAllBtn}
          onPress={() => setActiveView('all_fixtures')}
        >
          <Ionicons name="grid-outline" size={16} color="#FFF" style={{ marginRight: 8 }} />
          <Text style={styles.browseAllBtnText}>Browse All Scheduled Fixtures</Text>
        </TouchableOpacity>
      </View>
    );
  };

  const renderBasketballCard = ({ item }) => (
    <BasketballGameCard
      prediction={item}
      onPress={(matchPayload) => navigation.navigate('MatchDetails', { match: matchPayload })}
    />
  );

  const renderBasketballEmptyState = () => (
    <View style={styles.strictEmptyContainer}>
      <View style={styles.strictEmptyIconCircle}>
        <Ionicons name="basketball-outline" size={48} color="#00F2FE" />
      </View>
      <Text style={styles.strictEmptyTitle}>No Confident Basketball Picks</Text>
      <Text style={styles.strictEmptyDesc}>
        We analysed the scheduled games and none cleared the calibrated probability, edge and data-quality thresholds for the current filters.
      </Text>
      <Text style={styles.strictEmptySubtext}>
        Apex abstains rather than force a pick. Try another date, league, confidence or market filter.
      </Text>
    </View>
  );

  const renderBasketballHeader = () => (
    <View>
      <View style={styles.transparencyBar}>
        <Ionicons name="analytics-outline" size={14} color={theme.textSecondary} style={{ marginRight: 6 }} />
        <Text style={styles.transparencyBarText}>
          {basketballPredictions.length} game{basketballPredictions.length === 1 ? '' : 's'} with model probabilities
          {selectedLeague !== 'All' && selectedLeague !== 'Live' ? ` • ${selectedLeague}` : ''}
        </Text>
      </View>
      {basketballDisclaimer ? (
        <View style={styles.transparencyBar}>
          <Ionicons name="information-circle-outline" size={14} color={theme.textSecondary} style={{ marginRight: 6 }} />
          <Text style={styles.transparencyBarText}>{basketballDisclaimer}</Text>
        </View>
      ) : null}
    </View>
  );

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

        {/* Predictions / All Fixtures Segmented Control — Football & Basketball */}
        {(selectedCategory === 'Football' || selectedCategory === 'Basketball') && (
          <View style={styles.segmentedControlContainer}>
            <TouchableOpacity
              style={[styles.segTab, activeView === 'recommended' && styles.segTabActive]}
              onPress={() => setActiveView('recommended')}
              activeOpacity={0.8}
            >
              <Ionicons
                name={selectedCategory === 'Basketball' ? 'basketball-outline' : 'shield-checkmark-outline'}
                size={14}
                color={activeView === 'recommended' ? '#FFF' : '#10B981'}
                style={{ marginRight: 6 }}
              />
              <Text style={[styles.segTabText, activeView === 'recommended' && styles.segTabTextActive]}>
                {selectedCategory === 'Basketball' ? '🏀 Predictions' : '⭐ Recommended'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.segTab, activeView === 'all_fixtures' && styles.segTabActive]}
              onPress={() => setActiveView('all_fixtures')}
              activeOpacity={0.8}
            >
              <Ionicons name="globe-outline" size={14} color={activeView === 'all_fixtures' ? '#FFF' : '#00F2FE'} style={{ marginRight: 6 }} />
              <Text style={[styles.segTabText, activeView === 'all_fixtures' && styles.segTabTextActive]}>🌐 All Fixtures</Text>
            </TouchableOpacity>
          </View>
        )}

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
                {selectedCategory === 'Football' && (
                  <TouchableOpacity 
                      style={[styles.allLeaguesBtn, leagueModalVisible && styles.allLeaguesBtnActive]}
                      onPress={() => setLeagueModalVisible(true)}
                  >
                      <Ionicons name="globe-outline" size={14} color="#00F2FE" style={{ marginRight: 5 }} />
                      <Text style={styles.allLeaguesBtnText}>🌐 77 Leagues</Text>
                  </TouchableOpacity>
                )}
                {LEAGUES_FILTER[selectedCategory].map(league => (
                    <TouchableOpacity 
                        key={league} 
                        style={[styles.leaguePill, selectedLeague === league && styles.leaguePillActive]}
                        onPress={() => handleSelectLeague(league)}
                    >
                        <Text style={[styles.leagueTextFilter, selectedLeague === league && styles.leagueTextActive]}>{league}</Text>
                    </TouchableOpacity>
                ))}
            </ScrollView>

            {selectedCategory === 'Basketball' && activeView === 'recommended' && (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.subFiltersContent}>
                {CONFIDENCE_FILTERS.map(c => (
                  <TouchableOpacity
                    key={`conf_${c}`}
                    style={[styles.subFilterPill, basketballConfidence === c && styles.subFilterPillActive]}
                    onPress={() => setBasketballConfidence(c)}
                  >
                    <Text style={[styles.subFilterText, basketballConfidence === c && styles.subFilterTextActive]}>
                      {c === 'All' ? 'All Confidence' : c}
                    </Text>
                  </TouchableOpacity>
                ))}
                <View style={styles.verticalDivider} />
                {MARKET_FILTERS.map(m => (
                  <TouchableOpacity
                    key={`mkt_${m}`}
                    style={[styles.subFilterPill, basketballMarket === m && styles.subFilterPillActive]}
                    onPress={() => setBasketballMarket(m)}
                  >
                    <Text style={[styles.subFilterText, basketballMarket === m && styles.subFilterTextActive]}>
                      {m === 'All' ? 'All Markets' : m}
                    </Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            )}
        </View>
      </SafeAreaView>

      {/* Main List */}
      {loading ? (
        <View style={styles.centerContainer}>
            <ActivityIndicator size="large" color={theme.primary} />
            <Text style={styles.loadingText}>Finding best matches...</Text>
        </View>
      ) : selectedCategory === 'Football' && activeView === 'recommended' ? (
        loadingRecommended ? (
          <View style={styles.centerContainer}>
            <ActivityIndicator size="large" color="#10B981" />
            <Text style={styles.loadingText}>Scanning {recommendedData.totalAnalyzed || 'all'} fixtures for 75%+ probability markets...</Text>
          </View>
        ) : (
          <FlatList
            data={recommendedData.recommendations}
            renderItem={renderRecommendedCard}
            keyExtractor={(item, idx) => `rec_${item.fixtureId || idx}`}
            contentContainerStyle={styles.listContainer}
            showsVerticalScrollIndicator={false}
            initialNumToRender={5}
            refreshControl={
              <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#10B981" colors={['#10B981']} />
            }
            ListHeaderComponent={
              recommendedData.totalAnalyzed > 0 ? (
                <View style={styles.transparencyBar}>
                  <Ionicons name="analytics-outline" size={14} color={theme.textSecondary} style={{ marginRight: 6 }} />
                  <Text style={styles.transparencyBarText}>
                    Analyzed {recommendedData.totalAnalyzed} fixtures • {recommendedData.totalRecommended} qualified • {recommendedData.acceptanceRate}% acceptance rate
                  </Text>
                </View>
              ) : null
            }
            ListEmptyComponent={renderRecommendedEmptyState()}
          />
        )
      ) : selectedCategory === 'Basketball' && activeView === 'recommended' ? (
        loadingBasketball ? (
          <View style={styles.centerContainer}>
            <ActivityIndicator size="large" color="#10B981" />
            <Text style={styles.loadingText}>Running the basketball engine on today's games...</Text>
          </View>
        ) : (
          <FlatList
            data={basketballPredictions}
            renderItem={renderBasketballCard}
            keyExtractor={(item, idx) => `bb_${item.gameId || idx}`}
            contentContainerStyle={styles.listContainer}
            showsVerticalScrollIndicator={false}
            initialNumToRender={5}
            refreshControl={
              <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#10B981" colors={['#10B981']} />
            }
            ListHeaderComponent={renderBasketballHeader()}
            ListEmptyComponent={renderBasketballEmptyState()}
          />
        )
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

      {/* 77 Leagues Directory Modal */}
      <Modal
        visible={leagueModalVisible}
        animationType="slide"
        transparent={true}
        onRequestClose={() => setLeagueModalVisible(false)}
      >
        <SafeAreaView style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            {/* Modal Header */}
            <View style={styles.modalHeader}>
              <View>
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <Text style={styles.modalTitle}>All 77 Leagues</Text>
                  <View style={styles.verifiedBadge}>
                    <Text style={styles.verifiedBadgeText}>PitchAPI + ESPN</Text>
                  </View>
                </View>
                <Text style={styles.modalSubtitle}>Comprehensive multi-tier football coverage</Text>
              </View>
              <TouchableOpacity
                style={styles.modalCloseBtn}
                onPress={() => setLeagueModalVisible(false)}
              >
                <Ionicons name="close" size={24} color={theme.text} />
              </TouchableOpacity>
            </View>

            {/* Search Input */}
            <View style={styles.searchBarContainer}>
              <Ionicons name="search" size={18} color={theme.textSecondary} style={{ marginRight: 8 }} />
              <TextInput
                style={styles.searchInput}
                placeholder="Search league, country (e.g. Germany, Saudi, MLS)..."
                placeholderTextColor={theme.textSecondary}
                value={leagueSearchQuery}
                onChangeText={setLeagueSearchQuery}
                clearButtonMode="while-editing"
              />
              {leagueSearchQuery.length > 0 && (
                <TouchableOpacity onPress={() => setLeagueSearchQuery('')}>
                  <Ionicons name="close-circle" size={18} color={theme.textSecondary} />
                </TouchableOpacity>
              )}
            </View>

            {/* Region Tabs */}
            <View style={styles.regionTabsContainer}>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.regionTabsContent}>
                {REGIONS.map(reg => (
                  <TouchableOpacity
                    key={reg}
                    style={[styles.regionChip, selectedRegionTab === reg && styles.regionChipActive]}
                    onPress={() => setSelectedRegionTab(reg)}
                  >
                    <Text style={[styles.regionChipText, selectedRegionTab === reg && styles.regionChipTextActive]}>
                      {reg}
                    </Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </View>

            {/* Leagues Count / Selection Summary */}
            <View style={styles.resultSummaryRow}>
              <Text style={styles.resultSummaryText}>
                Showing {filtered77Leagues.length} of {leaguesCatalog.length} competitions
              </Text>
              {selectedLeague !== 'All' && (
                <TouchableOpacity onPress={() => handleSelectLeague('All')}>
                  <Text style={styles.resetFilterText}>Reset filter to All</Text>
                </TouchableOpacity>
              )}
            </View>

            {/* Leagues List */}
            <FlatList
              data={filtered77Leagues}
              keyExtractor={item => item.id || item.sourceId || item.name}
              showsVerticalScrollIndicator={false}
              contentContainerStyle={styles.leaguesListContainer}
              renderItem={({ item }) => {
                const isSelected = selectedLeague === item.name;
                return (
                  <TouchableOpacity
                    style={[styles.leagueDirectoryItem, isSelected && styles.leagueDirectoryItemActive]}
                    onPress={() => handleSelectLeague(item)}
                    activeOpacity={0.7}
                  >
                    <View style={styles.leagueLogoWrapper}>
                      {item.logo ? (
                        <Image source={{ uri: item.logo }} style={styles.leagueItemLogo} />
                      ) : (
                        <Ionicons name="football-outline" size={24} color={theme.primary} />
                      )}
                    </View>
                    <View style={styles.leagueItemInfo}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap' }}>
                        <Text style={[styles.leagueItemName, isSelected && styles.leagueItemNameActive]}>
                          {item.name}
                        </Text>
                        <View style={styles.countryPill}>
                          <Text style={styles.countryPillText}>{item.country}</Text>
                        </View>
                      </View>
                      <Text style={styles.leagueItemRegion}>
                        {item.region} • Season {item.season || '2024/2025'}
                      </Text>
                    </View>
                    <View style={styles.leagueItemRight}>
                      {isSelected ? (
                        <View style={styles.selectedCheckBadge}>
                          <Ionicons name="checkmark" size={16} color="#FFF" />
                        </View>
                      ) : (
                        <Ionicons name="chevron-forward" size={18} color={theme.textSecondary} />
                      )}
                    </View>
                  </TouchableOpacity>
                );
              }}
            />
          </View>
        </SafeAreaView>
      </Modal>
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
  subFiltersContent: {
    paddingHorizontal: moderateScale(20),
    paddingTop: verticalScale(8),
    alignItems: 'center',
  },
  subFilterPill: {
    paddingHorizontal: horizontalScale(12),
    paddingVertical: verticalScale(5),
    borderRadius: moderateScale(12),
    marginRight: horizontalScale(6),
    backgroundColor: theme.cardBg,
    borderWidth: 1,
    borderColor: theme.border,
  },
  subFilterPillActive: {
    borderColor: '#10B981',
    backgroundColor: isDarkMode ? 'rgba(16, 185, 129, 0.15)' : 'rgba(16, 185, 129, 0.08)',
  },
  subFilterText: {
    color: theme.textSecondary,
    fontSize: getResponsiveFontSize(11),
    fontWeight: '600',
  },
  subFilterTextActive: {
    color: '#10B981',
    fontWeight: '700',
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
  statusFinished: {
    backgroundColor: 'rgba(16, 185, 129, 0.15)',
  },
  statusText: {
    color: theme.text,
    fontSize: getResponsiveFontSize(12),
    fontWeight: '700',
  },
  statusTextLive: {
    color: '#FF6B6B',
  },
  statusTextFinished: {
    color: '#10B981',
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
  // ── Segmented Control ─────────────────────────────────────
  segmentedControlContainer: {
    flexDirection: 'row',
    marginHorizontal: moderateScale(20),
    marginBottom: verticalScale(8),
    backgroundColor: isDarkMode ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)',
    borderRadius: moderateScale(14),
    padding: moderateScale(4),
    borderWidth: 1,
    borderColor: theme.border,
  },
  segTab: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: verticalScale(8),
    borderRadius: moderateScale(11),
  },
  segTabActive: {
    backgroundColor: theme.primary,
    shadowColor: theme.primary,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.35,
    shadowRadius: 6,
    elevation: 4,
  },
  segTabText: {
    fontSize: getResponsiveFontSize(12),
    fontWeight: '700',
    color: theme.textSecondary,
  },
  segTabTextActive: {
    color: '#FFF',
  },
  // ── Recommended Card Extras ────────────────────────────────
  recommendedCardContainer: {
    borderColor: isDarkMode ? 'rgba(16, 185, 129, 0.35)' : 'rgba(16, 185, 129, 0.2)',
    borderWidth: 1.5,
  },
  validatedBadgeHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: isDarkMode ? 'rgba(16, 185, 129, 0.15)' : 'rgba(16, 185, 129, 0.08)',
    paddingHorizontal: horizontalScale(8),
    paddingVertical: verticalScale(4),
    borderRadius: moderateScale(8),
    borderWidth: 1,
    borderColor: 'rgba(16, 185, 129, 0.3)',
  },
  validatedBadgeHeaderText: {
    color: '#10B981',
    fontSize: getResponsiveFontSize(10),
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  placeholderLogo: {
    backgroundColor: isDarkMode ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)',
    borderRadius: moderateScale(10),
    alignItems: 'center',
    justifyContent: 'center',
  },
  kickoffTimeText: {
    color: theme.textSecondary,
    fontSize: getResponsiveFontSize(10),
    fontWeight: '600',
    marginTop: verticalScale(4),
  },
  recMarketBox: {
    backgroundColor: isDarkMode ? 'rgba(16, 185, 129, 0.07)' : 'rgba(16, 185, 129, 0.04)',
    borderRadius: moderateScale(14),
    padding: moderateScale(14),
    marginBottom: verticalScale(14),
    borderWidth: 1,
    borderColor: isDarkMode ? 'rgba(16, 185, 129, 0.2)' : 'rgba(16, 185, 129, 0.12)',
  },
  recMarketTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: verticalScale(8),
  },
  recMarketTag: {
    backgroundColor: 'rgba(16, 185, 129, 0.18)',
    paddingHorizontal: horizontalScale(8),
    paddingVertical: verticalScale(3),
    borderRadius: moderateScale(6),
  },
  recMarketTagText: {
    color: '#10B981',
    fontSize: getResponsiveFontSize(9),
    fontWeight: '800',
    letterSpacing: 0.6,
  },
  confidenceLabelPill: {
    backgroundColor: isDarkMode ? 'rgba(0, 242, 254, 0.12)' : 'rgba(0, 242, 254, 0.08)',
    paddingHorizontal: horizontalScale(8),
    paddingVertical: verticalScale(3),
    borderRadius: moderateScale(6),
    borderWidth: 1,
    borderColor: 'rgba(0, 242, 254, 0.25)',
  },
  confidenceLabelPillText: {
    color: '#00F2FE',
    fontSize: getResponsiveFontSize(9),
    fontWeight: '700',
  },
  recMarketTitle: {
    color: theme.text,
    fontSize: getResponsiveFontSize(16),
    fontWeight: '800',
    marginBottom: verticalScale(4),
  },
  recSelectionText: {
    color: theme.textSecondary,
    fontSize: getResponsiveFontSize(13),
    marginBottom: verticalScale(12),
  },
  metricsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
  },
  metricItem: {
    flex: 1,
    alignItems: 'center',
  },
  metricDivider: {
    width: 1,
    height: verticalScale(28),
    backgroundColor: theme.border,
  },
  metricLabel: {
    color: theme.textSecondary,
    fontSize: getResponsiveFontSize(10),
    fontWeight: '600',
    marginBottom: verticalScale(3),
  },
  metricValue: {
    color: theme.text,
    fontSize: getResponsiveFontSize(14),
    fontWeight: '800',
  },
  evidenceContainer: {
    marginBottom: verticalScale(14),
    paddingHorizontal: moderateScale(2),
  },
  evidenceHeading: {
    color: theme.textSecondary,
    fontSize: getResponsiveFontSize(11),
    fontWeight: '700',
    marginBottom: verticalScale(6),
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  evidenceBulletRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: verticalScale(4),
  },
  evidenceBulletText: {
    color: theme.textSecondary,
    fontSize: getResponsiveFontSize(12),
    flex: 1,
    lineHeight: verticalScale(17),
  },
  // ── Strict Empty State ─────────────────────────────────────
  strictEmptyContainer: {
    alignItems: 'center',
    marginTop: verticalScale(40),
    marginHorizontal: moderateScale(24),
    paddingHorizontal: moderateScale(10),
  },
  strictEmptyIconCircle: {
    width: moderateScale(90),
    height: moderateScale(90),
    borderRadius: moderateScale(45),
    backgroundColor: isDarkMode ? 'rgba(0, 242, 254, 0.08)' : 'rgba(0, 242, 254, 0.05)',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: 'rgba(0, 242, 254, 0.2)',
    marginBottom: verticalScale(20),
  },
  strictEmptyTitle: {
    color: theme.text,
    fontSize: getResponsiveFontSize(20),
    fontWeight: '800',
    textAlign: 'center',
    marginBottom: verticalScale(12),
  },
  strictEmptyDesc: {
    color: theme.textSecondary,
    fontSize: getResponsiveFontSize(14),
    textAlign: 'center',
    lineHeight: verticalScale(21),
    marginBottom: verticalScale(10),
  },
  strictEmptySubtext: {
    color: theme.textSecondary,
    fontSize: getResponsiveFontSize(12),
    textAlign: 'center',
    lineHeight: verticalScale(18),
    opacity: 0.7,
    marginBottom: verticalScale(24),
    fontStyle: 'italic',
  },
  browseAllBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.primary,
    paddingHorizontal: horizontalScale(20),
    paddingVertical: verticalScale(12),
    borderRadius: moderateScale(14),
  },
  browseAllBtnText: {
    color: '#FFF',
    fontSize: getResponsiveFontSize(14),
    fontWeight: '700',
  },
  // ── Transparency Bar ───────────────────────────────────────
  transparencyBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: isDarkMode ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)',
    borderRadius: moderateScale(10),
    paddingHorizontal: moderateScale(12),
    paddingVertical: verticalScale(8),
    marginBottom: verticalScale(10),
    borderWidth: 1,
    borderColor: theme.border,
  },
  transparencyBarText: {
    color: theme.textSecondary,
    fontSize: getResponsiveFontSize(11),
    fontWeight: '500',
    flex: 1,
  },
  allLeaguesBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: horizontalScale(14),
    paddingVertical: verticalScale(6),
    borderRadius: moderateScale(14),
    marginRight: horizontalScale(8),
    borderWidth: 1,
    borderColor: '#00F2FE',
    backgroundColor: isDarkMode ? 'rgba(0, 242, 254, 0.12)' : 'rgba(0, 242, 254, 0.08)',
  },
  allLeaguesBtnActive: {
    backgroundColor: '#00F2FE',
  },
  allLeaguesBtnText: {
    color: '#00F2FE',
    fontSize: getResponsiveFontSize(12),
    fontWeight: '700',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.75)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    flex: 1,
    marginTop: verticalScale(50),
    backgroundColor: theme.bg,
    borderTopLeftRadius: moderateScale(28),
    borderTopRightRadius: moderateScale(28),
    paddingTop: verticalScale(20),
    paddingHorizontal: moderateScale(20),
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: verticalScale(16),
  },
  modalTitle: {
    fontSize: getResponsiveFontSize(22),
    fontWeight: '800',
    color: theme.text,
  },
  verifiedBadge: {
    marginLeft: horizontalScale(8),
    backgroundColor: 'rgba(0, 242, 254, 0.15)',
    paddingHorizontal: horizontalScale(8),
    paddingVertical: verticalScale(2),
    borderRadius: moderateScale(6),
    borderWidth: 0.5,
    borderColor: '#00F2FE',
  },
  verifiedBadgeText: {
    color: '#00F2FE',
    fontSize: getResponsiveFontSize(10),
    fontWeight: '700',
  },
  modalSubtitle: {
    fontSize: getResponsiveFontSize(13),
    color: theme.textSecondary,
    marginTop: verticalScale(2),
  },
  modalCloseBtn: {
    padding: moderateScale(6),
    borderRadius: moderateScale(20),
    backgroundColor: theme.cardBg,
  },
  searchBarContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.cardBg,
    borderRadius: moderateScale(14),
    paddingHorizontal: horizontalScale(14),
    paddingVertical: verticalScale(10),
    borderWidth: 1,
    borderColor: theme.border,
    marginBottom: verticalScale(14),
  },
  searchInput: {
    flex: 1,
    color: theme.text,
    fontSize: getResponsiveFontSize(14),
    padding: 0,
  },
  regionTabsContainer: {
    marginBottom: verticalScale(12),
  },
  regionTabsContent: {
    alignItems: 'center',
  },
  regionChip: {
    paddingHorizontal: horizontalScale(14),
    paddingVertical: verticalScale(6),
    borderRadius: moderateScale(12),
    backgroundColor: theme.cardBg,
    marginRight: horizontalScale(8),
    borderWidth: 1,
    borderColor: theme.border,
  },
  regionChipActive: {
    borderColor: theme.primary,
    backgroundColor: isDarkMode ? 'rgba(52, 152, 219, 0.2)' : 'rgba(52, 152, 219, 0.1)',
  },
  regionChipText: {
    color: theme.textSecondary,
    fontSize: getResponsiveFontSize(12),
    fontWeight: '600',
  },
  regionChipTextActive: {
    color: theme.primary,
    fontWeight: '700',
  },
  resultSummaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: verticalScale(10),
    paddingHorizontal: horizontalScale(4),
  },
  resultSummaryText: {
    color: theme.textSecondary,
    fontSize: getResponsiveFontSize(12),
  },
  resetFilterText: {
    color: theme.primary,
    fontSize: getResponsiveFontSize(12),
    fontWeight: '600',
  },
  leaguesListContainer: {
    paddingBottom: verticalScale(40),
  },
  leagueDirectoryItem: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.cardBg,
    borderRadius: moderateScale(16),
    padding: moderateScale(14),
    marginBottom: verticalScale(10),
    borderWidth: 1,
    borderColor: theme.border,
  },
  leagueDirectoryItemActive: {
    borderColor: theme.primary,
    backgroundColor: isDarkMode ? 'rgba(52, 152, 219, 0.12)' : 'rgba(52, 152, 219, 0.05)',
  },
  leagueLogoWrapper: {
    width: moderateScale(40),
    height: moderateScale(40),
    borderRadius: moderateScale(10),
    backgroundColor: isDarkMode ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: horizontalScale(12),
    overflow: 'hidden',
  },
  leagueItemLogo: {
    width: moderateScale(32),
    height: moderateScale(32),
    resizeMode: 'contain',
  },
  leagueItemInfo: {
    flex: 1,
  },
  leagueItemName: {
    color: theme.text,
    fontSize: getResponsiveFontSize(15),
    fontWeight: '700',
    marginRight: horizontalScale(6),
  },
  leagueItemNameActive: {
    color: theme.primary,
  },
  countryPill: {
    backgroundColor: isDarkMode ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)',
    paddingHorizontal: horizontalScale(6),
    paddingVertical: verticalScale(2),
    borderRadius: moderateScale(6),
  },
  countryPillText: {
    color: theme.text,
    fontSize: getResponsiveFontSize(10),
    fontWeight: '700',
  },
  leagueItemRegion: {
    color: theme.textSecondary,
    fontSize: getResponsiveFontSize(12),
    marginTop: verticalScale(3),
  },
  leagueItemRight: {
    marginLeft: horizontalScale(8),
  },
  selectedCheckBadge: {
    width: moderateScale(24),
    height: moderateScale(24),
    borderRadius: moderateScale(12),
    backgroundColor: theme.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
