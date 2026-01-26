import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, ActivityIndicator, FlatList, Platform, Alert, Image } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import DateTimePicker from '@react-native-community/datetimepicker';
import { COLORS } from '../constants/colors';
import { horizontalScale, verticalScale, moderateScale, getResponsiveFontSize } from '../utils/responsive';
import { fetchMatches } from '../services/espn';
import { analyzeMatch } from '../utils/predictionLogic';

const SPORTS = [
  { id: 'soccer', name: 'Football', icon: 'football' },
  { id: 'basketball', name: 'Basketball', icon: 'basketball' }
];

const COUNTS = [3, 5, 10, 15];

export default function LeoScreen({ navigation }) {
  const [selectedSports, setSelectedSports] = useState(['soccer']);
  const [matchLimit, setMatchLimit] = useState(5);
  const [fromDate, setFromDate] = useState(new Date());
  const [toDate, setToDate] = useState(new Date(new Date().setDate(new Date().getDate() + 3)));
  const [showFromPicker, setShowFromPicker] = useState(false);
  const [showToPicker, setShowToPicker] = useState(false);
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState(null);

  const toggleSport = (sportId) => {
    setSelectedSports(prev => {
      if (prev.includes(sportId)) {
        return prev.length > 1 ? prev.filter(id => id !== sportId) : prev;
      } else {
        return [...prev, sportId];
      }
    });
  };

  const handleChase = async () => {
    setLoading(true);
    setResults(null);
    try {
      // Calculate days difference
      const diffTime = Math.abs(toDate - fromDate);
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)) + 1; // +1 to include start date

      // Fetch matches
      // Note: fetchMatches takes (days, startDate)
      const { all } = await fetchMatches(diffDays, fromDate);

      // Filter by Sport and Status (exclude finished and live games)
      // We only want 'pre' (Upcoming) matches for predictions
      let filteredMatches = all.filter(m => 
        selectedSports.includes(m.sport) && 
        m.status === 'pre'
      );

      // Analyze and Predict
      const analyzedMatches = filteredMatches.map(match => {
        const analysis = analyzeMatch({
          homeName: match.homeTeam.name,
          awayName: match.awayTeam.name,
          homeStats: match.homeTeam,
          awayStats: match.awayTeam,
          sport: match.sport,
          isDetailed: false // Basic analysis for list
        });
        return { ...match, analysis };
      });
      
      console.log(`Analyzed ${analyzedMatches.length} matches`);

      // Sort by Confidence (Highest to Lowest)
      // We take all valid matches and sort them to ensure we fill the requested limit
      let bestPredictions = analyzedMatches
        .sort((a, b) => b.analysis.confidence - a.analysis.confidence)
        .slice(0, matchLimit);

      setResults(bestPredictions);
      
      if (bestPredictions.length === 0) {
        Alert.alert(
            "Leo Says", 
            "No matches found for your criteria. Try widening the date range or selecting more sports."
        );
      }

    } catch (error) {
      console.error(error);
      Alert.alert("Error", "Leo couldn't fetch the data. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const onFromDateChange = (event, selectedDate) => {
    setShowFromPicker(false);
    if (selectedDate) {
      setFromDate(selectedDate);
      if (selectedDate > toDate) {
        setToDate(new Date(selectedDate.getTime() + 86400000)); // +1 day
      }
    }
  };

  const onToDateChange = (event, selectedDate) => {
    setShowToPicker(false);
    if (selectedDate) {
      setToDate(selectedDate);
    }
  };

  const formatDate = (date) => {
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  const renderResultItem = ({ item }) => (
    <TouchableOpacity 
        style={styles.resultCard}
        onPress={() => navigation.navigate('MatchDetails', { match: item })}
    >
      <View style={styles.cardHeader}>
        <Text style={styles.leagueText}>{item.league}</Text>
        <Text style={styles.dateText}>{formatDate(item.date)} • {item.time}</Text>
      </View>
      
      <View style={styles.matchRow}>
        <View style={styles.teamContainer}>
            <Image source={{ uri: item.homeTeam.logo }} style={styles.teamLogo} />
            <Text style={styles.teamName} numberOfLines={1}>{item.homeTeam.name}</Text>
        </View>
        <Text style={styles.vsText}>VS</Text>
        <View style={styles.teamContainer}>
            <Image source={{ uri: item.awayTeam.logo }} style={styles.teamLogo} />
            <Text style={styles.teamName} numberOfLines={1}>{item.awayTeam.name}</Text>
        </View>
      </View>

      <View style={styles.predictionContainer}>
        <View style={styles.confidenceBadge}>
            <Text style={styles.confidenceText}>{item.analysis.confidence}%</Text>
        </View>
        <Text style={[styles.predictionText, { color: item.analysis.color }]}>
            {item.analysis.prediction}
        </Text>
      </View>
    </TouchableOpacity>
  );

  return (
    <View style={styles.container}>
      <LinearGradient
        colors={[COLORS.primary, '#1a1a1a']}
        style={styles.headerGradient}
      >
        <SafeAreaView edges={['top']} style={styles.safeHeader}>
            <View style={styles.headerContent}>
                <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
                    <Ionicons name="arrow-back" size={24} color="#FFF" />
                </TouchableOpacity>
                <Text style={styles.headerTitle}>Leo Assistant</Text>
                <View style={{ width: 24 }} />
            </View>
        </SafeAreaView>
      </LinearGradient>

      <ScrollView contentContainerStyle={styles.scrollContent}>
        {/* Controls Section */}
        <View style={styles.controlsSection}>
            <Text style={styles.sectionLabel}>Select Sport</Text>
            <View style={styles.pillsRow}>
                {SPORTS.map(sport => (
                    <TouchableOpacity
                        key={sport.id}
                        style={[styles.pill, selectedSports.includes(sport.id) && styles.activePill]}
                        onPress={() => toggleSport(sport.id)}
                    >
                        <Ionicons 
                            name={sport.icon} 
                            size={16} 
                            color={selectedSports.includes(sport.id) ? '#FFF' : COLORS.textSecondary} 
                        />
                        <Text style={[styles.pillText, selectedSports.includes(sport.id) && styles.activePillText]}>
                            {sport.name}
                        </Text>
                    </TouchableOpacity>
                ))}
            </View>

            <Text style={styles.sectionLabel}>Date Range</Text>
            <View style={styles.dateRow}>
                <TouchableOpacity style={styles.dateButton} onPress={() => setShowFromPicker(true)}>
                    <Text style={styles.dateLabel}>From</Text>
                    <Text style={styles.dateValue}>{formatDate(fromDate)}</Text>
                </TouchableOpacity>
                <Ionicons name="arrow-forward" size={20} color={COLORS.textSecondary} />
                <TouchableOpacity style={styles.dateButton} onPress={() => setShowToPicker(true)}>
                    <Text style={styles.dateLabel}>To</Text>
                    <Text style={styles.dateValue}>{formatDate(toDate)}</Text>
                </TouchableOpacity>
            </View>
            {(showFromPicker || showToPicker) && (
                <DateTimePicker
                    value={showFromPicker ? fromDate : toDate}
                    mode="date"
                    display={Platform.OS === 'ios' ? 'spinner' : 'default'}
                    onChange={showFromPicker ? onFromDateChange : onToDateChange}
                    minimumDate={new Date()}
                />
            )}

            <Text style={styles.sectionLabel}>Max Predictions</Text>
            <View style={styles.pillsRow}>
                {COUNTS.map(count => (
                    <TouchableOpacity
                        key={count}
                        style={[styles.countPill, matchLimit === count && styles.activePill]}
                        onPress={() => setMatchLimit(count)}
                    >
                        <Text style={[styles.pillText, matchLimit === count && styles.activePillText]}>
                            {count}
                        </Text>
                    </TouchableOpacity>
                ))}
            </View>

            <TouchableOpacity 
                style={styles.chaseButton}
                onPress={handleChase}
                disabled={loading}
            >
                {loading ? (
                    <ActivityIndicator color="#FFF" />
                ) : (
                    <LinearGradient
                        colors={[COLORS.accent, '#e6c38a']}
                        style={styles.chaseGradient}
                        start={{x: 0, y: 0}}
                        end={{x: 1, y: 0}}
                    >
                        <Text style={styles.chaseBtnText}>LEO CHASE</Text>
                        <Ionicons name="flash" size={20} color={COLORS.primary} />
                    </LinearGradient>
                )}
            </TouchableOpacity>
        </View>

        {/* Results Section */}
        {results && (
            <View style={styles.resultsSection}>
                <Text style={styles.resultsTitle}>Top {results.length} Picks</Text>
                {results.map((item, index) => (
                    <View key={item.id}>
                        {renderResultItem({ item })}
                    </View>
                ))}
            </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.bg,
  },
  headerGradient: {
    paddingBottom: verticalScale(20),
    borderBottomLeftRadius: moderateScale(30),
    borderBottomRightRadius: moderateScale(30),
  },
  safeHeader: {
    paddingHorizontal: moderateScale(20),
  },
  headerContent: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: verticalScale(10),
  },
  headerTitle: {
    color: '#FFF',
    fontSize: getResponsiveFontSize(20),
    fontWeight: 'bold',
  },
  backBtn: {
    padding: 5,
  },
  scrollContent: {
    padding: moderateScale(20),
  },
  controlsSection: {
    backgroundColor: COLORS.cardBg,
    padding: moderateScale(20),
    borderRadius: moderateScale(20),
    marginBottom: verticalScale(20),
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.05)',
  },
  sectionLabel: {
    color: COLORS.textSecondary,
    fontSize: getResponsiveFontSize(14),
    marginBottom: verticalScale(10),
    fontWeight: '600',
  },
  pillsRow: {
    flexDirection: 'row',
    marginBottom: verticalScale(20),
    flexWrap: 'wrap',
    gap: horizontalScale(10),
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.05)',
    paddingVertical: verticalScale(8),
    paddingHorizontal: horizontalScale(16),
    borderRadius: moderateScale(20),
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  countPill: {
    backgroundColor: 'rgba(255,255,255,0.05)',
    paddingVertical: verticalScale(8),
    paddingHorizontal: horizontalScale(20),
    borderRadius: moderateScale(20),
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  activePill: {
    backgroundColor: COLORS.primary,
    borderColor: COLORS.accent,
  },
  pillText: {
    color: COLORS.textSecondary,
    fontSize: getResponsiveFontSize(14),
    fontWeight: '500',
    marginLeft: horizontalScale(6),
  },
  activePillText: {
    color: '#FFF',
    fontWeight: 'bold',
  },
  dateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: verticalScale(20),
  },
  dateButton: {
    flex: 1,
    backgroundColor: 'rgba(255,255,255,0.05)',
    padding: moderateScale(12),
    borderRadius: moderateScale(12),
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    marginHorizontal: horizontalScale(5),
  },
  dateLabel: {
    color: COLORS.textSecondary,
    fontSize: getResponsiveFontSize(12),
    marginBottom: verticalScale(4),
  },
  dateValue: {
    color: '#FFF',
    fontSize: getResponsiveFontSize(16),
    fontWeight: 'bold',
  },
  chaseButton: {
    marginTop: verticalScale(10),
    borderRadius: moderateScale(15),
    overflow: 'hidden',
  },
  chaseGradient: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: verticalScale(15),
  },
  chaseBtnText: {
    color: COLORS.primary,
    fontSize: getResponsiveFontSize(18),
    fontWeight: '900',
    marginRight: horizontalScale(8),
    letterSpacing: 1,
  },
  resultsSection: {
    marginTop: verticalScale(10),
  },
  resultsTitle: {
    color: '#FFF',
    fontSize: getResponsiveFontSize(18),
    fontWeight: 'bold',
    marginBottom: verticalScale(15),
    marginLeft: horizontalScale(5),
  },
  resultCard: {
    backgroundColor: COLORS.cardBg,
    borderRadius: moderateScale(16),
    padding: moderateScale(16),
    marginBottom: verticalScale(16),
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.05)',
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: verticalScale(12),
  },
  leagueText: {
    color: COLORS.textSecondary,
    fontSize: getResponsiveFontSize(12),
    fontWeight: '600',
  },
  dateText: {
    color: COLORS.textSecondary,
    fontSize: getResponsiveFontSize(12),
  },
  matchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: verticalScale(16),
  },
  teamContainer: {
    flex: 1,
    alignItems: 'center',
  },
  teamLogo: {
    width: horizontalScale(40),
    height: horizontalScale(40),
    resizeMode: 'contain',
    marginBottom: verticalScale(8),
  },
  teamName: {
    color: '#FFF',
    fontSize: getResponsiveFontSize(12),
    textAlign: 'center',
    fontWeight: '500',
  },
  vsText: {
    color: COLORS.textSecondary,
    fontSize: getResponsiveFontSize(12),
    fontWeight: 'bold',
    marginHorizontal: horizontalScale(10),
  },
  predictionContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.05)',
    padding: moderateScale(12),
    borderRadius: moderateScale(12),
  },
  confidenceBadge: {
    backgroundColor: COLORS.primary,
    paddingHorizontal: horizontalScale(8),
    paddingVertical: verticalScale(4),
    borderRadius: moderateScale(8),
    marginRight: horizontalScale(10),
  },
  confidenceText: {
    color: '#FFF',
    fontSize: getResponsiveFontSize(12),
    fontWeight: 'bold',
  },
  predictionText: {
    fontSize: getResponsiveFontSize(14),
    fontWeight: 'bold',
    flex: 1,
  },
});
