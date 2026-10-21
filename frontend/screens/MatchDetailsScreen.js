import React, { useEffect, useState, useRef } from 'react';
import { View, Text, StyleSheet, ScrollView, Image, ActivityIndicator, Linking, TouchableOpacity, StatusBar, Platform, Animated } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { SafeAreaView } from 'react-native-safe-area-context';
import { horizontalScale, verticalScale, moderateScale, getResponsiveFontSize } from '../utils/responsive';
import { fetchTeamDetails, fetchMatchAnalysis, fetchGamesStats } from '../services/espn';
import { checkBackendHealth, fetchMatchPrediction, savePredictionToBackend, fetchPredictionSettlement } from '../services/api';
import { useUser } from '../context/UserContext';
import { Alert } from 'react-native';
import { InterstitialAd, AdEventType } from 'react-native-google-mobile-ads';
import { AdUnits } from '../constants/ads';
import { GlobalBannerAd } from '../components/GlobalBannerAd';
import { useTheme } from '../context/ThemeContext';

export default function MatchDetailsScreen({ route, navigation }) {
  const { theme, isDarkMode } = useTheme();
  const styles = createStyles(theme, isDarkMode);
  
  const { match } = route.params || {};
  const { balance, subtractBalance, user } = useUser();
  const [loading, setLoading] = useState(true);
  const [homeDetails, setHomeDetails] = useState(null);
  const [awayDetails, setAwayDetails] = useState(null);
  const [matchAnalysis, setMatchAnalysis] = useState(null);
  const [h2hDeepStats, setH2HDeepStats] = useState([]);
  const [showPrediction, setShowPrediction] = useState(false);
  // Backend prediction state
  const [botAnalysis, setBotAnalysis] = useState(null);
  const [settlementData, setSettlementData] = useState(null);
  const [predictionLoading, setPredictionLoading] = useState(false);
  const [predictionError, setPredictionError] = useState(null);
  const [adLoaded, setAdLoaded] = useState(false);
  const interstitialRef = useRef(null);
  const pendingActionRef = useRef(null);

  // Basketball prediction from TipsScreen
  const basketballPrediction = match?.basketballPrediction || null;

  // Load Interstitial Ad
  useEffect(() => {
    const ad = InterstitialAd.createForAdRequest(AdUnits.INTERSTITIAL, {
      requestNonPersonalizedAdsOnly: true,
    });

    const unsubscribeLoaded = ad.addAdEventListener(AdEventType.LOADED, () => {
      setAdLoaded(true);
    });

    const unsubscribeClosed = ad.addAdEventListener(AdEventType.CLOSED, () => {
      if (pendingActionRef.current) {
        navigation.dispatch(pendingActionRef.current);
        pendingActionRef.current = null;
      }
    });

    ad.load();
    interstitialRef.current = ad;

    return () => {
      unsubscribeLoaded();
      unsubscribeClosed();
    };
  }, [navigation]);

  // Handle Navigation with Ad
  useEffect(() => {
    const unsubscribe = navigation.addListener('beforeRemove', (e) => {
      if (adLoaded && interstitialRef.current && !pendingActionRef.current) {
        e.preventDefault();
        pendingActionRef.current = e.data.action;
        interstitialRef.current.show();
        setAdLoaded(false);
      }
    });

    return unsubscribe;
  }, [navigation, adLoaded]);

  // Helper to safely get team name whether it's a string (legacy) or object (new)
  const getTeamName = (team) => (typeof team === 'object' ? team.name : team);
  const getTeamLogo = (team) => (typeof team === 'object' ? team.logo : null);
  const getTeamId = (team) => (typeof team === 'object' ? team.id : null);

  const homeName = getTeamName(match?.homeTeam || 'Team A');
  const awayName = getTeamName(match?.awayTeam || 'Team B');
  const homeLogo = getTeamLogo(match?.homeTeam);
  const awayLogo = getTeamLogo(match?.awayTeam);
  
  const displayDate = match?.date ? new Date(match.date).toLocaleString() : 'Today';

  useEffect(() => {
    const loadData = async () => {
      if (match?.sport && match?.leagueSlug && match?.id) {
        setLoading(true);

        // Check Backend Status (Public IP)
        checkBackendHealth().then(status => console.log('Backend Connection Status:', status));

        try {
          // Fetch detailed info for both teams and the match itself
          const [home, away, analysis] = await Promise.all([
            fetchTeamDetails(match.sport, match.leagueSlug, getTeamId(match.homeTeam)),
            fetchTeamDetails(match.sport, match.leagueSlug, getTeamId(match.awayTeam)),
            fetchMatchAnalysis(match.sport, match.leagueSlug, match.id)
          ]);

          setHomeDetails(home);
          setAwayDetails(away);
          setMatchAnalysis(analysis);

          // Fetch Deep Stats for H2H (Cards, Corners)
          if (analysis?.headToHeadGames?.length > 0) {
            const validH2H = analysis.headToHeadGames.filter(g =>
              String(g.id) !== String(match.id) &&
              g.homeTeamScore !== undefined &&
              g.awayTeamScore !== undefined
            );
            if (validH2H.length > 0) {
              const gameIds = validH2H.slice(0, 5).map(g => g.id);
              const deepStats = await fetchGamesStats(match.sport, match.leagueSlug, gameIds);
              setH2HDeepStats(deepStats);
            }
          }

          // --- Fetch prediction from backend (server-side ESPN data + algorithm) ---
          // Skip basketball predictions as they use the dedicated engine from TipsScreen
          const homeId = getTeamId(match.homeTeam);
          const awayId = getTeamId(match.awayTeam);
          if (homeId && awayId && match?.sport !== 'basketball') {
            setPredictionLoading(true);
            setPredictionError(null);
            try {
              const predResult = await fetchMatchPrediction(
                match.id,
                match.sport,
                match.leagueSlug,
                homeId,
                awayId,
                user?.uid // Pass userId to check for saved predictions
              );
              if (predResult && predResult.recommendations) {
                setBotAnalysis(predResult);
                // If loaded from saved prediction, show settlement data if available
                if (predResult.fromSavedPrediction && predResult.settlementStatus === 'settled') {
                  setShowPrediction(true);
                }
              } else {
                setPredictionError('Prediction data unavailable. Try again later.');
              }
            } catch (predErr) {
              console.warn('Prediction fetch failed:', predErr);
              // Distinguish between network errors and server errors
              if (predErr.message?.includes('Network') || predErr.message?.includes('fetch')) {
                setPredictionError('Network error. Check your connection.');
              } else {
                setPredictionError('Could not generate prediction. Please try again.');
              }
            } finally {
              setPredictionLoading(false);
            }
          }

          // --- Check settlement status for this match (both football and basketball) ---
          try {
            const settleRes = await fetchPredictionSettlement(match.id, user?.uid);
            if (settleRes) {
              setSettlementData(settleRes);
              // Reveal predictions automatically if match has already been settled
              if (settleRes.settlementStatus === 'settled') {
                setShowPrediction(true);
              }
            }
          } catch (settleErr) {
            console.warn('Settlement fetch failed:', settleErr);
          }
        } catch (error) {
          console.error('Failed to load match details', error);
        } finally {
          setLoading(false);
        }
      } else {
        setLoading(false);
      }
    };

    loadData();
  }, [match, user?.uid]);

  // Refresh settlement when screen regains focus (avoids stale Pending after background settle)
  useEffect(() => {
    const refreshSettlement = async () => {
      if (!match?.id) return;
      try {
        const settleRes = await fetchPredictionSettlement(match.id, user?.uid);
        if (!settleRes) return;
        setSettlementData(prev => {
          // Never overwrite a settled result with an older pending cache
          if (prev?.settlementStatus === 'settled' && settleRes.settlementStatus !== 'settled') {
            return prev;
          }
          return settleRes;
        });
        if (settleRes.settlementStatus === 'settled') {
          setShowPrediction(true);
        }
      } catch (e) {
        console.warn('Settlement refresh failed:', e);
      }
    };

    const unsub = navigation.addListener('focus', refreshSettlement);
    return unsub;
  }, [navigation, match?.id, user?.uid]);

  // Poll while the match is finished but markets are still pending (bounded interval)
  useEffect(() => {
    const isFinished = match?.status === 'post' || match?.status === 'finished';
    const stillPending =
      !settlementData ||
      settlementData.settlementStatus !== 'settled' ||
      (settlementData.results || []).some(r => r.outcome === 'pending');

    if (!isFinished || !stillPending || !match?.id) return undefined;

    let cancelled = false;
    const tick = async () => {
      try {
        const settleRes = await fetchPredictionSettlement(match.id, user?.uid);
        if (cancelled || !settleRes) return;
        setSettlementData(prev => {
          if (prev?.settlementStatus === 'settled' && settleRes.settlementStatus !== 'settled') {
            return prev;
          }
          return settleRes;
        });
        if (settleRes.settlementStatus === 'settled') {
          setShowPrediction(true);
        }
      } catch (_) { /* ignore poll errors */ }
    };

    const intervalId = setInterval(tick, 30000);
    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [match?.id, match?.status, settlementData?.settlementStatus, user?.uid]);

  // Generate consistent stats based on team name (Fallback if API fails)
  const getAverageStats = (name, sport) => {
    return '-';
  };

  const statLabel = match?.sport === 'basketball' ? 'Avg Points' : 'Avg Goals';
  const homeStats = homeDetails?.stats?.formString || '-';
  const awayStats = awayDetails?.stats?.formString || '-';

  const renderForm = (formString) => {
    if (!formString || formString === '-') return <Text style={styles.statValue}>-</Text>;
    return (
      <View style={styles.formContainer}>
        {formString.split('-').map((result, index) => (
          <View key={index} style={[
            styles.formBadge, 
            result === 'W' ? styles.win : 
            result === 'L' ? styles.loss : styles.draw
          ]}>
            <Text style={styles.formText}>{result}</Text>
          </View>
        ))}
      </View>
    );
  };

  // Calculate H2H Stats
  const getH2HStats = () => {
    const currentHomeId = getTeamId(match?.homeTeam);
    const currentAwayId = getTeamId(match?.awayTeam);

    // 1. Try API provided H2H data (More accurate/comprehensive)
    if (matchAnalysis?.headToHeadGames && matchAnalysis.headToHeadGames.length > 0) {
      let homeWins = 0;
      let awayWins = 0;
      let draws = 0;
      
      const validH2H = matchAnalysis.headToHeadGames.filter(g => 
          String(g.id) !== String(match?.id) && 
          g.homeTeamScore !== undefined && 
          g.awayTeamScore !== undefined
      );

      const recent = validH2H.slice(0, 5).map(game => {
        const hScore = parseInt(game.homeTeamScore || 0);
        const aScore = parseInt(game.awayTeamScore || 0);
        
        // Determine winner relative to Current Home Team
        // Note: game.homeTeamId is the host of THAT match
        const isCurrentHomeHosting = String(game.homeTeamId) === String(currentHomeId);
        
        if (hScore === aScore) {
            draws++;
        } else if (isCurrentHomeHosting) {
            if (hScore > aScore) homeWins++;
            else awayWins++;
        } else {
            // Current Away Team was hosting (or neutral, assuming away if not home)
            if (aScore > hScore) homeWins++; // Current home team was away and won
            else awayWins++;
        }
        
        return {
            date: game.gameDate,
            score: game.score ? game.score.replace(/\s/g, '') : '?-?',
            id: game.id
        };
      });

      return {
        homeWins,
        awayWins,
        draws,
        recent
      };
    }

    // 2. Fallback: Check recent meetings from loaded schedules
    const homeSchedule = homeDetails?.lastMatches || [];
    const recentMeetings = homeSchedule.filter(m => String(m.opponentId) === String(currentAwayId));
    
    let homeWins = 0;
    let awayWins = 0;
    let draws = 0;

    recentMeetings.forEach(m => {
        if (m.pf > m.pa) homeWins++;
        else if (m.pf < m.pa) awayWins++;
        else draws++;
    });
    
    return {
      homeWins,
      awayWins,
      draws,
      recent: recentMeetings
    };
  };

  const h2h = getH2HStats();
  const h2hWithDeepStats = { ...h2h, deepStats: h2hDeepStats };

  // Advanced Metrics Calculations
  const getAdvancedMetrics = () => {
    const isBasketball = match?.sport === 'basketball';
    
    // Check if we have valid live/post match stats
    const hasMatchStats = matchAnalysis && (
        isBasketball 
          ? matchAnalysis.homeStats.fgPct !== '0' 
          : (matchAnalysis.homeStats.possession !== '0' || matchAnalysis.homeStats.shots !== '0')
    );

    if (isBasketball) {
      if (!matchAnalysis && !homeDetails) return null;

      const h = matchAnalysis?.homeStats || {};
      const a = matchAnalysis?.awayStats || {};

      // If live stats available, use them
      if (hasMatchStats) {
          const getPossessions = (stats) => (stats.fga || 85) + 0.44 * (stats.fta || 20) - (stats.orb || 10) + (stats.tov || 14);
          const homePoss = getPossessions(h);
          const awayPoss = getPossessions(a);
          const pace = ((homePoss + awayPoss) / 2).toFixed(1);
          
          const getEFG = (stats) => stats.fga ? (((stats.fgm + 0.5 * stats.threePm) / stats.fga) * 100).toFixed(1) : 0;
          
          return {
            type: 'basketball',
            pace,
            netRtg: (((h.pts/homePoss)*100) - ((a.pts/awayPoss)*100)).toFixed(1),
            homeEFG: getEFG(h),
            awayEFG: getEFG(a),
            homeRebPct: h.rebounds,
            awayRebPct: a.rebounds
          };
      } 
      // Fallback for Basketball Upcoming (High Precision Prediction)
      if (homeDetails && awayDetails) {
          const calcTeamEff = (matches) => {
              if (!matches || !matches.length) return null;
              const pts = matches.reduce((sum, m) => sum + m.pf, 0) / matches.length;
              const pa = matches.reduce((sum, m) => sum + m.pa, 0) / matches.length;
              // Very rough possession estimate for upcoming: 
              // Avg pts + (Avg pa / 2) - typically around 70-80 possessions for non-pro
              return { pts, pa };
          };
          
          const h = calcTeamEff(homeDetails.lastMatches);
          const a = calcTeamEff(awayDetails.lastMatches);
          
          if (h && a) {
              // Estimate Pace: Average of historical scoring outputs / 1.1 (proxy)
              const estPace = ((h.pts + a.pts + h.pa + a.pa) / 4).toFixed(1);
              const homeOffRtg = ((h.pts / estPace) * 100).toFixed(1);
              const awayOffRtg = ((a.pts / estPace) * 100).toFixed(1);

              return {
                  type: 'basketball',
                  pace: estPace,
                  netRtg: (homeOffRtg - awayOffRtg).toFixed(1),
                  homeEFG: 'N/A', // eFG requires shooting splits stats
                  awayEFG: 'N/A',
                  homeOffRtg,
                  awayOffRtg,
                  isPredicted: true
              };
          }
      }
      return null; 
    } else {
      // Football Metrics
      // 1. Try Live/Post Match Data
      if (hasMatchStats) {
          const h = matchAnalysis.homeStats;
          const a = matchAnalysis.awayStats;
          const getXGProxy = (stats) => ((stats.shotsOnTarget || 0) * 0.3 + (stats.shots || 0) * 0.05).toFixed(2);
          const homeXG = getXGProxy(h);
          const awayXG = getXGProxy(a);
          
          return {
            type: 'soccer',
            homeXG,
            awayXG,
            xGDiff: (homeXG - awayXG).toFixed(2),
            homePossession: h.possession,
            awayPossession: a.possession,
            homePassPct: h.passPct,
            awayPassPct: a.passPct,
            isPredicted: false
          };
      }
      
      // 2. Predict for Upcoming Match (User Request)
      if (homeDetails && awayDetails) {
         const calcStats = (matches) => {
             if (!matches || !matches.length) return null;
             const totalGf = matches.reduce((sum, m) => sum + m.pf, 0);
             const totalGa = matches.reduce((sum, m) => sum + m.pa, 0);
             return {
               gf: totalGf / matches.length,
               ga: totalGa / matches.length
             };
        };

        const hStats = calcStats(homeDetails.lastMatches);
        const aStats = calcStats(awayDetails.lastMatches);
        
        if (!hStats || !aStats) return null;
        
        const homeAdvantage = 1.15;
        const homeXG = ((hStats.gf + aStats.ga) / 2 * homeAdvantage).toFixed(2);
        const awayXG = ((aStats.gf + hStats.ga) / 2).toFixed(2);
        const xGDiff = (homeXG - awayXG).toFixed(2);
        
        // Estimate Possession based on xG dominance
        const diffVal = parseFloat(xGDiff);
        let hPoss = 50 + (diffVal * 10); 
        hPoss = Math.min(Math.max(hPoss, 35), 65); // Clamp
        
        return {
            type: 'soccer',
            homeXG,
            awayXG,
            xGDiff,
            homePossession: Math.round(hPoss),
            awayPossession: Math.round(100 - hPoss),
            homePassPct: '-',
            awayPassPct: '-',
            isPredicted: true
        };
      }
      
      return null;
    }
  };

  const advancedMetrics = getAdvancedMetrics();

  // Animation for confidence bar
  const confidenceAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (botAnalysis && match?.sport !== 'basketball') {
      confidenceAnim.setValue(0); // Reset
      const timer = setTimeout(() => {
        Animated.timing(confidenceAnim, {
          toValue: botAnalysis.confidence,
          duration: 1000,
          useNativeDriver: false
        }).start();
      }, 1500);
      return () => clearTimeout(timer);
    }
  }, [botAnalysis, match?.sport]);

  const getConfidenceColor = (conf) => {
      if (conf >= 70) return theme.success; // High - Green
      if (conf >= 50) return theme.accent; // Medium - Cream/Gold (Accent)
      return theme.error; // Low - Red
  };

  const handleUnlockPrediction = async () => {
    const success = await subtractBalance(1);
    if (success) {
        setShowPrediction(true);

        // Persist original prediction to Firestore for automatic tick/cross settlement
        if (match?.sport === 'basketball' && basketballPrediction) {
          // Save basketball prediction
          savePredictionToBackend({
            userId: user?.uid || 'anonymous',
            matchId: String(match.id),
            sport: 'basketball',
            leagueSlug: match.leagueSlug || '',
            league: match.league || '',
            homeName,
            awayName,
            homeTeamId: getTeamId(match.homeTeam),
            awayTeamId: getTeamId(match.awayTeam),
            matchDate: match.date || null,
            predictions: basketballPrediction.picks.map(p => ({
              market: p.market || '',
              label: p.market || '',
              value: p.selection || '',
              confidence: p.confidence || 'Medium',
              selection: p.selection || '',
            })),
          });
        } else if (botAnalysis && botAnalysis.recommendations && match) {
          // Save football prediction
          savePredictionToBackend({
            userId: user?.uid || 'anonymous',
            matchId: String(match.id),
            sport: match.sport || 'soccer',
            leagueSlug: match.leagueSlug || '',
            league: match.league || '',
            homeName,
            awayName,
            homeTeamId: getTeamId(match.homeTeam),
            awayTeamId: getTeamId(match.awayTeam),
            matchDate: match.date || null,
            predictions: botAnalysis.recommendations.map(r => ({
              market: r.type ? r.type.toLowerCase() : '',
              label: r.label,
              value: r.value,
              confidence: r.confidence,
              selection: r.value,
            })),
          });
        }
    } else {
        Alert.alert(
            "Insufficient Balance",
            "You need 1 APT to view this prediction.",
            [
                { text: "Cancel", style: "cancel" },
                { text: "Get Tokens", onPress: () => navigation.navigate('Market') }
            ]
        );
    }
  };

  return (
    <View style={styles.container}>
      <StatusBar barStyle={isDarkMode ? "light-content" : "dark-content"} />
      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        {/* Gradient Header */}
        <LinearGradient
            colors={[theme.cardBg, theme.bg]}
            start={{x: 0, y: 0}}
            end={{x: 0, y: 1}}
            style={styles.headerGradient}
        >
            <SafeAreaView edges={['top', 'left', 'right']}>
                <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backButton}>
                    <Ionicons name="arrow-back" size={24} color={theme.text} />
                </TouchableOpacity>
                <Text style={styles.leagueTitle}>{match?.league || 'League'}</Text>
                
                <View style={styles.scoreContainer}>
                    <View style={styles.teamContainer}>
                        {homeLogo && <Image source={{ uri: homeLogo }} style={styles.teamLogo} />}
                        <Text style={styles.teamName} numberOfLines={2}>{homeName}</Text>
                    </View>
                    <View style={styles.vsContainer}>
                        <Text style={styles.vsText}>VS</Text>
                        <View style={styles.timeTag}>
                             <Text style={styles.timeText}>{displayDate.split(',')[1]?.trim() || 'Today'}</Text>
                        </View>
                    </View>
                    <View style={styles.teamContainer}>
                        {awayLogo && <Image source={{ uri: awayLogo }} style={styles.teamLogo} />}
                        <Text style={styles.teamName} numberOfLines={2}>{awayName}</Text>
                    </View>
                </View>
                {matchAnalysis?.matchInfo?.venue && (
                    <Text style={styles.venueText}>{matchAnalysis.matchInfo.venue}</Text>
                )}
            </SafeAreaView>
        </LinearGradient>

      {loading ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={theme.primary} />
          <Text style={styles.loadingText}>Analyzing Match Data...</Text>
        </View>
      ) : (
        <View style={styles.contentContainer}>
          {/* AI Match Analysis — powered by backend prediction engine */}
          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <Text style={styles.cardTitle}>AI Match Analysis</Text>
              {botAnalysis?.meta && (
                <Text style={styles.predictionMeta}>via live ESPN data</Text>
              )}
            </View>

            {predictionLoading ? (
              <View style={styles.predictionLoadingContainer}>
                <ActivityIndicator size="small" color={theme.primary} />
                <Text style={styles.predictionLoadingText}>Generating prediction...</Text>
              </View>
            ) : predictionError ? (
              <View style={styles.predictionErrorContainer}>
                <Ionicons name="cloud-offline-outline" size={32} color={theme.textSecondary} />
                <Text style={styles.predictionErrorText}>{predictionError}</Text>
              </View>
            ) : match?.sport === 'basketball' ? (
              // Basketball uses same UI pattern as football
              basketballPrediction ? (
                !showPrediction ? (
                  <View style={styles.lockedContainer}>
                    <Ionicons name="lock-closed" size={40} color={theme.textSecondary} />
                    <Text style={styles.lockedText}>AI Tips Locked</Text>
                    <Text style={styles.lockedSubText}>Unlock to see the top predictions for this match.</Text>
                    <TouchableOpacity style={styles.unlockButton} onPress={handleUnlockPrediction}>
                      <LinearGradient
                        colors={[theme.primary, theme.warning]}
                        start={{x: 0, y: 0}}
                        end={{x: 1, y: 0}}
                        style={styles.unlockGradient}
                      >
                        <Text style={styles.unlockText}>Unlock All Tips (1 APT)</Text>
                        <Ionicons name="key" size={16} color="#FFF" style={{ marginLeft: 8 }} />
                      </LinearGradient>
                    </TouchableOpacity>
                  </View>
                ) : (
                  <>
                    <View style={styles.tipsList}>
                      {basketballPrediction.picks && basketballPrediction.picks.length > 0 ? (
                        basketballPrediction.picks.map((pick, idx) => {
                          const pickColor = pick.market === 'Total Points' ? '#00F2FE' : '#FF6B6B';
                          return (
                            <View key={idx} style={[styles.tipCard, { borderLeftColor: pickColor }]}>
                              <View style={styles.tipHeader}>
                                <View style={[styles.tipTypeBadge, { backgroundColor: pickColor + '20' }]}>
                                  <Text style={[styles.tipTypeText, { color: pickColor }]}>{pick.market}</Text>
                                </View>
                                <Text style={styles.tipConfidence}>
                                  {Math.round((basketballPrediction.data_quality || 0) * 100)}% Data Quality
                                </Text>
                              </View>
                              <Text style={styles.tipValue}>{pick.selection}</Text>
                              <View style={styles.pickStatsRow}>
                                <Text style={styles.pickStat}>Probability: {(pick.probability * 100).toFixed(1)}%</Text>
                                <Text style={styles.pickStat}>Edge: {(pick.edge * 100).toFixed(1)}%</Text>
                              </View>
                              {pick.reasoning && (
                                <Text style={styles.pickReasoningText}>{pick.reasoning}</Text>
                              )}
                            </View>
                          );
                        })
                      ) : (
                        <View style={styles.predictionErrorContainer}>
                          <Ionicons name="shield-checkmark-outline" size={32} color={theme.textSecondary} />
                          <Text style={styles.predictionErrorText}>
                            No predictions available for this match.
                          </Text>
                        </View>
                      )}
                    </View>

                    {basketballPrediction.picks && basketballPrediction.picks.length > 0 && (
                      <View style={styles.divider} />
                    )}

                    {basketballPrediction.picks && basketballPrediction.picks.length > 0 && homeDetails && awayDetails && (
                      <>
                      <View style={styles.formSection}>
                      <Text style={styles.subTitle}>Recent Form</Text>
                      <View style={styles.teamFormRow}>
                        <Text style={styles.teamFormName} numberOfLines={1}>{homeName}</Text>
                        {renderForm(homeStats)}
                      </View>
                      <View style={styles.teamFormRow}>
                        <Text style={styles.teamFormName} numberOfLines={1}>{awayName}</Text>
                        {renderForm(awayStats)}
                      </View>
                    </View>

                    <View style={styles.divider} />

                    <Text style={styles.subTitle}>Key Factors</Text>
                    {basketballPrediction.risk_flags && basketballPrediction.risk_flags.length > 0 ? (
                      basketballPrediction.risk_flags.map((flag, i) => (
                        <View key={i} style={styles.factorRow}>
                          <View style={[styles.factorDot, { backgroundColor: theme.warning }]} />
                          <Text style={styles.factorText}>{flag}</Text>
                        </View>
                      ))
                    ) : (
                      <View style={styles.factorRow}>
                        <View style={[styles.factorDot, { backgroundColor: theme.textSecondary }]} />
                        <Text style={styles.factorText}>Standard analysis applied</Text>
                      </View>
                    )}
                      </>
                    )}
                  </>
                )
              ) : (
                <View style={styles.predictionErrorContainer}>
                  <Ionicons name="information-circle-outline" size={32} color={theme.textSecondary} />
                  <Text style={styles.predictionErrorText}>
                    No basketball prediction available. Please check the Tips screen for calibrated predictions.
                  </Text>
                </View>
              )
            ) : botAnalysis ? (
              !showPrediction ? (
                <View style={styles.lockedContainer}>
                  <Ionicons name="lock-closed" size={40} color={theme.textSecondary} />
                  <Text style={styles.lockedText}>AI Tips Locked</Text>
                  <Text style={styles.lockedSubText}>Unlock to see the top 2 highest-confidence predictions for this match.</Text>
                  <TouchableOpacity style={styles.unlockButton} onPress={handleUnlockPrediction}>
                    <LinearGradient
                      colors={[theme.primary, theme.warning]}
                      start={{x: 0, y: 0}}
                      end={{x: 1, y: 0}}
                      style={styles.unlockGradient}
                    >
                      <Text style={styles.unlockText}>Unlock All Tips (1 APT)</Text>
                      <Ionicons name="key" size={16} color="#FFF" style={{ marginLeft: 8 }} />
                    </LinearGradient>
                  </TouchableOpacity>
                </View>
              ) : (
                <>
                  {/* Verified Settlement Banner (full or partial with verified score) */}
                  {(settlementData?.settlementStatus === 'settled' ||
                    (settlementData?.actualHomeScore != null && settlementData?.actualAwayScore != null)) && (
                    <View style={styles.settlementBanner}>
                      <View style={styles.settlementBannerHeader}>
                        <Ionicons name="checkmark-done-circle" size={20} color="#10B981" />
                        <Text style={styles.settlementBannerTitle}>
                          {settlementData.settlementStatus === 'settled'
                            ? 'Match Completed & Settled'
                            : 'Match Completed — Finalizing Markets'}
                        </Text>
                      </View>
                      <Text style={styles.settlementScoreText}>
                        Final Score: {homeName} {settlementData.actualHomeScore} - {settlementData.actualAwayScore} {awayName}
                      </Text>
                      {settlementData.actualHtHome !== null && settlementData.actualHtAway !== null && (
                        <Text style={styles.settlementHtText}>
                          (Half-Time: {settlementData.actualHtHome} - {settlementData.actualHtAway})
                        </Text>
                      )}
                    </View>
                  )}

                  <View style={styles.tipsList}>
                    {botAnalysis.recommendations && botAnalysis.recommendations.length > 0 ? (
                      botAnalysis.recommendations.map((rec, i) => {
                      const recMarketKey = (rec.type || '').toLowerCase();
                      const outcomeObj = settlementData?.results?.find(r =>
                        r.market === recMarketKey ||
                        r.label === rec.label ||
                        (r.market && recMarketKey && (r.market.includes(recMarketKey) || recMarketKey.includes(r.market)))
                      );
                      const outcome = outcomeObj ? outcomeObj.outcome : null;
                      const isFinished = match?.status === 'post' || settlementData?.settlementStatus === 'settled';

                      return (
                        <View key={i} style={[styles.tipCard, { borderLeftColor: rec.color }]}>
                          <View style={styles.tipHeader}>
                            <View style={[styles.tipTypeBadge, { backgroundColor: rec.color + '20' }]}>
                              <Text style={[styles.tipTypeText, { color: rec.color }]}>{rec.label}</Text>
                            </View>

                            <View style={styles.settleBadgeRow}>
                              {/* Automatic Tick / Cross / Pending Badge */}
                              {isFinished ? (
                                outcome === 'won' ? (
                                  <View style={styles.settleWonBadge}>
                                    <Ionicons name="checkmark-circle" size={13} color="#10B981" />
                                    <Text style={styles.settleWonText}>WON</Text>
                                  </View>
                                ) : outcome === 'lost' ? (
                                  <View style={styles.settleLostBadge}>
                                    <Ionicons name="close-circle" size={13} color="#EF4444" />
                                    <Text style={styles.settleLostText}>LOST</Text>
                                  </View>
                                ) : outcome === 'void' ? (
                                  <View style={styles.settleUpcomingBadge}>
                                    <Ionicons name="remove-circle-outline" size={13} color={theme.textSecondary} />
                                    <Text style={styles.settleUpcomingText}>VOID</Text>
                                  </View>
                                ) : (
                                  <View style={styles.settlePendingBadge}>
                                    <Ionicons name="time-outline" size={13} color="#F59E0B" />
                                    <Text style={styles.settlePendingText}>PENDING</Text>
                                  </View>
                                )
                              ) : (
                                <View style={styles.settleUpcomingBadge}>
                                  <Ionicons name="hourglass-outline" size={12} color={theme.textSecondary} />
                                  <Text style={styles.settleUpcomingText}>PENDING</Text>
                                </View>
                              )}

                              <Text style={styles.tipConfidence}>
                                {typeof rec.confidence === 'number' ? rec.confidence.toFixed(1) : rec.confidence}% Conf.
                              </Text>
                            </View>
                          </View>
                          <Text style={styles.tipValue}>{rec.value}</Text>
                        </View>
                      );
                    })
                    ) : (
                      <View style={styles.predictionErrorContainer}>
                        <Ionicons name="shield-checkmark-outline" size={32} color={theme.textSecondary} />
                        <Text style={styles.predictionErrorText}>
                          No predictions currently meet the confidence threshold.
                        </Text>
                      </View>
                    )}
                  </View>

                  {botAnalysis.recommendations && botAnalysis.recommendations.length > 0 && (
                    <View style={styles.divider} />
                  )}

                  {botAnalysis.recommendations && botAnalysis.recommendations.length > 0 && (
                    <>
                    <View style={styles.formSection}>
                    <Text style={styles.subTitle}>Recent Form</Text>
                    <View style={styles.teamFormRow}>
                      <Text style={styles.teamFormName} numberOfLines={1}>{homeName}</Text>
                      {renderForm(homeStats)}
                    </View>
                    <View style={styles.teamFormRow}>
                      <Text style={styles.teamFormName} numberOfLines={1}>{awayName}</Text>
                      {renderForm(awayStats)}
                    </View>
                  </View>

                  <View style={styles.divider} />

                  <Text style={styles.subTitle}>Key Factors</Text>
                  {botAnalysis.factors && botAnalysis.factors.map((factor, i) => (
                    <View key={i} style={styles.factorRow}>
                      <View style={[
                        styles.factorDot,
                        { backgroundColor: factor.side === 'home' ? theme.success : (factor.side === 'away' ? theme.error : theme.textSecondary) }
                      ]} />
                      <Text style={styles.factorText}>
                        <Text style={{fontWeight: 'bold'}}>
                          {factor.side === 'home' ? homeName : (factor.side === 'away' ? awayName : 'Both')}
                        </Text>: {factor.label}
                      </Text>
                    </View>
                  ))}
                    </>
                  )}
                </>
              )
            ) : (
              <View style={styles.predictionErrorContainer}>
                <Ionicons name="analytics-outline" size={32} color={theme.textSecondary} />
                <Text style={styles.predictionErrorText}>Prediction not available for this match.</Text>
              </View>
            )}
          </View>

          {advancedMetrics && (
            <View style={styles.card}>
              <View style={styles.cardHeader}>
                <Text style={styles.cardTitle}>Advanced Metrics</Text>
              </View>
              
              <View style={styles.metricsGrid}>
                {advancedMetrics.type === 'basketball' ? (
                  <>
                    <View style={styles.metricItem}>
                        <Text style={styles.metricLabel}>Pace</Text>
                        <Text style={styles.metricValue}>{advancedMetrics.pace}</Text>
                    </View>
                    <View style={styles.metricItem}>
                        <Text style={styles.metricLabel}>Net Rtg</Text>
                        <Text style={styles.metricValue}>{advancedMetrics.netRtg}</Text>
                    </View>
                    <View style={styles.metricItem}>
                        <Text style={styles.metricLabel}>Home eFG%</Text>
                        <Text style={styles.metricValue}>{advancedMetrics.homeEFG}%</Text>
                    </View>
                     <View style={styles.metricItem}>
                        <Text style={styles.metricLabel}>Away eFG%</Text>
                        <Text style={styles.metricValue}>{advancedMetrics.awayEFG}%</Text>
                    </View>
                  </>
                ) : (
                   <>
                    <View style={styles.metricItem}>
                        <Text style={styles.metricLabel}>Home xG</Text>
                        <Text style={styles.metricValue}>{advancedMetrics.homeXG}</Text>
                    </View>
                    <View style={styles.metricItem}>
                        <Text style={styles.metricLabel}>Away xG</Text>
                        <Text style={styles.metricValue}>{advancedMetrics.awayXG}</Text>
                    </View>
                    <View style={styles.metricItem}>
                        <Text style={styles.metricLabel}>Possession</Text>
                        <Text style={styles.metricValue}>{advancedMetrics.homePossession}% / {advancedMetrics.awayPossession}%</Text>
                    </View>
                   </>
                )}
              </View>
            </View>
          )}

          <View style={styles.card}>
            <View style={styles.cardHeader}>
                <Text style={styles.cardTitle}>Head to Head</Text>
            </View>
            <View style={styles.h2hRow}>
                <View style={styles.h2hStat}>
                    <Text style={styles.h2hValue}>{h2h.homeWins}</Text>
                    <Text style={styles.h2hLabel}>{homeName}</Text>
                </View>
                <View style={styles.h2hStat}>
                    <Text style={styles.h2hValue}>{h2h.draws}</Text>
                    <Text style={styles.h2hLabel}>Draw</Text>
                </View>
                <View style={styles.h2hStat}>
                    <Text style={styles.h2hValue}>{h2h.awayWins}</Text>
                    <Text style={styles.h2hLabel}>{awayName}</Text>
                </View>
            </View>
          </View>
        </View>
      )}
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
      paddingBottom: verticalScale(40),
  },
  headerGradient: {
      paddingTop: Platform.OS === 'ios' ? verticalScale(10) : verticalScale(20),
      paddingBottom: verticalScale(30),
      paddingHorizontal: moderateScale(20),
      borderBottomLeftRadius: moderateScale(30),
      borderBottomRightRadius: moderateScale(30),
  },
  backButton: {
      marginBottom: verticalScale(10),
      padding: 5,
  },
  leagueTitle: {
      color: theme.textSecondary,
      fontSize: getResponsiveFontSize(14),
      textAlign: 'center',
      marginBottom: verticalScale(10),
      textTransform: 'uppercase',
      letterSpacing: 1,
  },
  scoreContainer: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginTop: verticalScale(10),
  },
  teamContainer: {
      flex: 1,
      alignItems: 'center',
  },
  teamLogo: {
      width: horizontalScale(60),
      height: horizontalScale(60),
      resizeMode: 'contain',
      marginBottom: verticalScale(8),
  },
  teamName: {
      color: theme.text,
      fontSize: getResponsiveFontSize(14),
      fontWeight: 'bold',
      textAlign: 'center',
  },
  vsContainer: {
      alignItems: 'center',
      width: horizontalScale(50),
  },
  vsText: {
      color: theme.text,
      fontSize: getResponsiveFontSize(24),
      fontWeight: '900',
      fontStyle: 'italic',
  },
  timeTag: {
      backgroundColor: isDarkMode ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.05)',
      paddingHorizontal: horizontalScale(8),
      paddingVertical: verticalScale(4),
      borderRadius: moderateScale(4),
      marginTop: verticalScale(4),
  },
  timeText: {
      color: theme.accent,
      fontSize: getResponsiveFontSize(10),
      fontWeight: 'bold',
  },
  venueText: {
      color: theme.textSecondary,
      fontSize: getResponsiveFontSize(12),
      textAlign: 'center',
      marginTop: verticalScale(15),
  },
  loadingContainer: {
      paddingTop: verticalScale(50),
      alignItems: 'center',
  },
  loadingText: {
      color: theme.textSecondary,
      marginTop: verticalScale(10),
  },
  contentContainer: {
      padding: moderateScale(20),
  },
  card: {
      backgroundColor: theme.cardBg,
      borderRadius: moderateScale(16),
      padding: moderateScale(20),
      marginBottom: verticalScale(20),
      borderWidth: 1,
      borderColor: theme.border,
  },
  cardHeader: {
      marginBottom: verticalScale(15),
      borderBottomWidth: 1,
      borderBottomColor: theme.border,
      paddingBottom: verticalScale(10),
  },
  cardTitle: {
      color: theme.text,
      fontSize: getResponsiveFontSize(18),
      fontWeight: 'bold',
  },
  predictionBox: {
      alignItems: 'center',
      marginBottom: verticalScale(20),
  },
  predictionLabel: {
      color: theme.textSecondary,
      fontSize: getResponsiveFontSize(12),
      marginBottom: verticalScale(5),
      letterSpacing: 1,
  },
  predictionValue: {
      fontSize: getResponsiveFontSize(24),
      fontWeight: 'bold',
  },
  confidenceRow: {
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: verticalScale(20),
  },
  confidenceLabel: {
      color: theme.textSecondary,
      width: horizontalScale(80),
      fontSize: getResponsiveFontSize(12),
  },
  confidenceBarBg: {
      flex: 1,
      height: verticalScale(8),
      backgroundColor: isDarkMode ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)',
      borderRadius: moderateScale(4),
      marginHorizontal: horizontalScale(10),
      overflow: 'hidden',
  },
  confidenceBarFill: {
      height: '100%',
      borderRadius: moderateScale(4),
  },
  confidenceValue: {
      color: theme.text,
      fontSize: getResponsiveFontSize(12),
      fontWeight: 'bold',
      width: horizontalScale(30),
      textAlign: 'right',
  },
  divider: {
      height: 1,
      backgroundColor: theme.border,
      marginVertical: verticalScale(15),
  },
  subTitle: {
      color: theme.text,
      fontSize: getResponsiveFontSize(16),
      fontWeight: '600',
      marginBottom: verticalScale(10),
  },
  factorRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      marginBottom: verticalScale(8),
  },
  factorDot: {
      width: 8,
      height: 8,
      borderRadius: 4,
      marginTop: 6,
      marginRight: 10,
  },
  factorText: {
      color: theme.textSecondary,
      fontSize: getResponsiveFontSize(13),
      flex: 1,
      lineHeight: 20,
  },
  metricsGrid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      justifyContent: 'space-between',
  },
  metricItem: {
      width: '48%',
      backgroundColor: isDarkMode ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.03)',
      padding: moderateScale(10),
      borderRadius: moderateScale(8),
      marginBottom: verticalScale(10),
      alignItems: 'center',
  },
  metricLabel: {
      color: theme.textSecondary,
      fontSize: getResponsiveFontSize(12),
      marginBottom: verticalScale(4),
  },
  metricValue: {
      color: theme.text,
      fontSize: getResponsiveFontSize(16),
      fontWeight: 'bold',
  },
  h2hRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  h2hStat: {
    alignItems: 'center',
    flex: 1,
  },
  h2hValue: {
    color: theme.text,
    fontSize: getResponsiveFontSize(20),
    fontWeight: 'bold',
    marginBottom: verticalScale(4),
  },
  h2hLabel: {
    color: theme.textSecondary,
    fontSize: getResponsiveFontSize(12),
  },
  formContainer: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
  },
  formBadge: {
    width: horizontalScale(24),
    height: horizontalScale(24),
    borderRadius: moderateScale(12),
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: horizontalScale(4),
  },
  win: { backgroundColor: theme.success },
  loss: { backgroundColor: theme.error },
  draw: { backgroundColor: theme.textSecondary },
  formText: {
    color: '#fff',
    fontSize: getResponsiveFontSize(10),
    fontWeight: 'bold',
  },
  lockedContainer: {
    alignItems: 'center',
    padding: moderateScale(20),
    backgroundColor: isDarkMode ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.03)',
    borderRadius: moderateScale(16),
    marginVertical: verticalScale(10),
  },
  lockedText: {
    color: theme.textSecondary,
    fontSize: getResponsiveFontSize(14),
    marginTop: verticalScale(10),
    marginBottom: verticalScale(15),
  },
  unlockButton: {
    width: '100%',
    overflow: 'hidden',
    borderRadius: moderateScale(12),
  },
  unlockGradient: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: verticalScale(12),
  },
  unlockText: {
    color: '#FFF',
    fontSize: getResponsiveFontSize(16),
    fontWeight: 'bold',
  },
  formSection: {
    marginBottom: verticalScale(20),
  },
  teamFormRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: verticalScale(12),
  },
  teamFormName: {
      color: theme.textSecondary,
      fontSize: getResponsiveFontSize(14),
      fontWeight: '600',
      maxWidth: '60%',
  },
  statValue: {
    color: theme.text,
    fontSize: getResponsiveFontSize(14),
    fontWeight: 'bold',
  },
  tipsList: {
    marginTop: verticalScale(10),
  },
  tipCard: {
    backgroundColor: isDarkMode ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.02)',
    borderRadius: moderateScale(16),
    padding: moderateScale(16),
    marginBottom: verticalScale(12),
    borderLeftWidth: 6,
    borderWidth: 1,
    borderColor: theme.border,
  },
  tipHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: verticalScale(8),
  },
  tipTypeBadge: {
    paddingHorizontal: horizontalScale(10),
    paddingVertical: verticalScale(4),
    borderRadius: moderateScale(6),
  },
  tipTypeText: {
    fontSize: getResponsiveFontSize(10),
    fontWeight: 'bold',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  tipConfidence: {
    color: theme.textSecondary,
    fontSize: getResponsiveFontSize(11),
    fontWeight: '600',
  },
  tipValue: {
    color: theme.text,
    fontSize: getResponsiveFontSize(18),
    fontWeight: 'bold',
    letterSpacing: 0.2,
  },
  lockedSubText: {
    color: theme.textSecondary,
    fontSize: getResponsiveFontSize(12),
    textAlign: 'center',
    marginBottom: verticalScale(20),
    paddingHorizontal: horizontalScale(20),
  },
  // --- Backend prediction UI styles ---
  predictionMeta: {
    color: theme.textSecondary,
    fontSize: getResponsiveFontSize(11),
    fontStyle: 'italic',
    marginTop: verticalScale(2),
  },
  predictionLoadingContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: verticalScale(20),
    gap: 10,
  },
  predictionLoadingText: {
    color: theme.textSecondary,
    fontSize: getResponsiveFontSize(13),
    marginLeft: horizontalScale(8),
  },
  predictionErrorContainer: {
    alignItems: 'center',
    paddingVertical: verticalScale(24),
    gap: 10,
  },
  predictionErrorText: {
    color: theme.textSecondary,
    fontSize: getResponsiveFontSize(13),
    textAlign: 'center',
    marginTop: verticalScale(8),
    paddingHorizontal: horizontalScale(10),
  },
  // --- Settlement UI styles ---
  settleBadgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  settleWonBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(16, 185, 129, 0.15)',
    paddingHorizontal: horizontalScale(8),
    paddingVertical: verticalScale(3),
    borderRadius: moderateScale(6),
    borderWidth: 1,
    borderColor: 'rgba(16, 185, 129, 0.3)',
    gap: 4,
  },
  settleWonText: {
    color: '#10B981',
    fontSize: getResponsiveFontSize(10),
    fontWeight: 'bold',
    letterSpacing: 0.5,
  },
  settleLostBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(239, 68, 68, 0.15)',
    paddingHorizontal: horizontalScale(8),
    paddingVertical: verticalScale(3),
    borderRadius: moderateScale(6),
    borderWidth: 1,
    borderColor: 'rgba(239, 68, 68, 0.3)',
    gap: 4,
  },
  settleLostText: {
    color: '#EF4444',
    fontSize: getResponsiveFontSize(10),
    fontWeight: 'bold',
    letterSpacing: 0.5,
  },
  settlePendingBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(245, 158, 11, 0.15)',
    paddingHorizontal: horizontalScale(8),
    paddingVertical: verticalScale(3),
    borderRadius: moderateScale(6),
    borderWidth: 1,
    borderColor: 'rgba(245, 158, 11, 0.3)',
    gap: 4,
  },
  settlePendingText: {
    color: '#F59E0B',
    fontSize: getResponsiveFontSize(10),
    fontWeight: 'bold',
    letterSpacing: 0.5,
  },
  settleUpcomingBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: isDarkMode ? 'rgba(255, 255, 255, 0.05)' : 'rgba(0, 0, 0, 0.05)',
    paddingHorizontal: horizontalScale(8),
    paddingVertical: verticalScale(3),
    borderRadius: moderateScale(6),
    borderWidth: 1,
    borderColor: theme.border,
    gap: 4,
  },
  settleUpcomingText: {
    color: theme.textSecondary,
    fontSize: getResponsiveFontSize(10),
    fontWeight: '600',
    letterSpacing: 0.5,
  },
  settlementBanner: {
    backgroundColor: 'rgba(16, 185, 129, 0.08)',
    borderRadius: moderateScale(12),
    borderWidth: 1,
    borderColor: 'rgba(16, 185, 129, 0.25)',
    padding: moderateScale(12),
    marginBottom: verticalScale(14),
    alignItems: 'center',
  },
  settlementBannerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: verticalScale(4),
  },
  settlementBannerTitle: {
    color: '#10B981',
    fontSize: getResponsiveFontSize(12),
    fontWeight: 'bold',
    letterSpacing: 0.3,
  },
  settlementScoreText: {
    color: theme.text,
    fontSize: getResponsiveFontSize(15),
    fontWeight: 'bold',
    marginTop: verticalScale(2),
  },
  settlementHtText: {
    color: theme.textSecondary,
    fontSize: getResponsiveFontSize(11),
    marginTop: verticalScale(2),
  },
  // Basketball prediction styles
  projectionRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: verticalScale(8),
    borderBottomWidth: 1,
    borderBottomColor: theme.border,
  },
  projectionLabel: {
    color: theme.textSecondary,
    fontSize: getResponsiveFontSize(13),
  },
  projectionValue: {
    color: theme.text,
    fontSize: getResponsiveFontSize(15),
    fontWeight: 'bold',
  },
  pickSection: {
    marginTop: verticalScale(12),
    paddingTop: verticalScale(12),
    borderTopWidth: 1,
    borderTopColor: theme.border,
  },
  pickRowHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: verticalScale(8),
  },
  pickMarketLabel: {
    color: theme.text,
    fontSize: getResponsiveFontSize(13),
    fontWeight: 'bold',
  },
  confidenceMiniBadge: {
    paddingHorizontal: horizontalScale(8),
    paddingVertical: verticalScale(3),
    borderRadius: moderateScale(6),
  },
  confidenceHigh: {
    backgroundColor: 'rgba(16, 185, 129, 0.2)',
  },
  confidenceMedium: {
    backgroundColor: 'rgba(245, 158, 11, 0.2)',
  },
  confidenceLow: {
    backgroundColor: 'rgba(239, 68, 68, 0.2)',
  },
  confidenceMiniText: {
    fontSize: getResponsiveFontSize(10),
    fontWeight: 'bold',
    color: theme.text,
  },
  pickSelectionText: {
    color: theme.text,
    fontSize: getResponsiveFontSize(16),
    fontWeight: 'bold',
    marginBottom: verticalScale(6),
  },
  pickStatsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: verticalScale(6),
  },
  pickStat: {
    color: theme.textSecondary,
    fontSize: getResponsiveFontSize(12),
  },
  pickReasoningText: {
    color: theme.textSecondary,
    fontSize: getResponsiveFontSize(12),
    lineHeight: getResponsiveFontSize(17),
    marginTop: verticalScale(4),
  },
  noPickText: {
    color: theme.textSecondary,
    fontSize: getResponsiveFontSize(13),
    fontStyle: 'italic',
    textAlign: 'center',
    marginTop: verticalScale(12),
  },
});

