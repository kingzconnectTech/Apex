import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, FlatList } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { COLORS } from '../constants/colors';

// Dummy data for upcoming matches
const UPCOMING_MATCHES = [
  { id: '1', homeTeam: 'Arsenal', awayTeam: 'Man City', time: '20:00', league: 'Premier League', date: 'Today' },
  { id: '2', homeTeam: 'Lakers', awayTeam: 'Warriors', time: '22:30', league: 'NBA', date: 'Today' },
  { id: '3', homeTeam: 'Real Madrid', awayTeam: 'Barcelona', time: '19:45', league: 'La Liga', date: 'Tomorrow' },
  { id: '4', homeTeam: 'PSG', awayTeam: 'Marseille', time: '21:00', league: 'Ligue 1', date: 'Tomorrow' },
];

export default function HomeScreen({ navigation }) {

  const renderMatchItem = ({ item }) => (
    <TouchableOpacity 
      style={styles.matchCard} 
      onPress={() => navigation.navigate('MatchDetails', { match: item })}
    >
      <View style={styles.matchHeader}>
        <Text style={styles.leagueText}>{item.league}</Text>
        <Text style={styles.dateText}>{item.time}</Text>
      </View>
      <View style={styles.matchTeams}>
        <Text style={styles.teamText}>{item.homeTeam}</Text>
        <Text style={styles.vsText}>VS</Text>
        <Text style={styles.teamText}>{item.awayTeam}</Text>
      </View>
      <View style={styles.analysisBadge}>
        <Text style={styles.analysisText}>View Analysis</Text>
        <Ionicons name="arrow-forward" size={14} color={COLORS.bg} />
      </View>
    </TouchableOpacity>
  );

  return (
    <ScrollView style={styles.container} showsVerticalScrollIndicator={false}>
      {/* Hero Section */}
      <View style={styles.heroSection}>
        <Text style={styles.heroTitle}>Welcome to Apex</Text>
        <Text style={styles.heroSubtitle}>
          Precision Sports Predictions powered by AI.
        </Text>
        <TouchableOpacity 
          style={styles.huntButton}
          onPress={() => navigation.navigate('Tips')}
        >
          <Text style={styles.huntButtonText}>HUNT</Text>
          <Ionicons name="target" size={20} color={COLORS.bg} style={{ marginLeft: 8 }} />
        </TouchableOpacity>
      </View>

      {/* Stats Section */}
      <View style={styles.statsContainer}>
        <View style={styles.statBox}>
          <Text style={styles.statNumber}>85%</Text>
          <Text style={styles.statLabel}>Accuracy</Text>
        </View>
        <View style={styles.statBox}>
          <Text style={styles.statNumber}>250+</Text>
          <Text style={styles.statLabel}>Active Users</Text>
        </View>
        <View style={styles.statBox}>
          <Text style={styles.statNumber}>400%</Text>
          <Text style={styles.statLabel}>ROI</Text>
        </View>
      </View>

      {/* Upcoming Matches Section */}
      <View style={styles.matchesSection}>
        <Text style={styles.sectionTitle}>Upcoming Matches</Text>
        <FlatList
          data={UPCOMING_MATCHES}
          renderItem={renderMatchItem}
          keyExtractor={item => item.id}
          scrollEnabled={false} // Disable scrolling since we are inside a ScrollView
        />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.bg,
  },
  heroSection: {
    backgroundColor: COLORS.primary, 
    padding: 30,
    paddingTop: 60,
    borderBottomLeftRadius: 30,
    borderBottomRightRadius: 30,
    alignItems: 'center',
    marginBottom: 20,
    shadowColor: COLORS.secondary,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 5,
    elevation: 5,
  },
  heroTitle: {
    fontSize: 28,
    fontWeight: 'bold',
    color: COLORS.white,
    marginBottom: 10,
  },
  heroSubtitle: {
    fontSize: 16,
    color: COLORS.accent,
    textAlign: 'center',
    marginBottom: 25,
    lineHeight: 22,
  },
  huntButton: {
    backgroundColor: COLORS.accent,
    paddingVertical: 12,
    paddingHorizontal: 30,
    borderRadius: 25,
    flexDirection: 'row',
    alignItems: 'center',
    elevation: 5,
    shadowColor: COLORS.accent,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 5,
  },
  huntButtonText: {
    color: COLORS.bg,
    fontSize: 16,
    fontWeight: 'bold',
    letterSpacing: 1,
  },
  statsContainer: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    paddingHorizontal: 15,
    marginBottom: 25,
    marginTop: -10,
  },
  statBox: {
    backgroundColor: COLORS.cardBg,
    padding: 15,
    borderRadius: 15,
    alignItems: 'center',
    width: '30%',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
    elevation: 3,
    borderWidth: 1,
    borderColor: COLORS.primary,
  },
  statNumber: {
    fontSize: 18,
    fontWeight: 'bold',
    color: COLORS.accent,
    marginBottom: 5,
  },
  statLabel: {
    fontSize: 12,
    color: COLORS.textSecondary,
    textAlign: 'center',
  },
  matchesSection: {
    paddingHorizontal: 20,
    paddingBottom: 20,
  },
  sectionTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    color: COLORS.text,
    marginBottom: 15,
  },
  matchCard: {
    backgroundColor: COLORS.cardBg,
    borderRadius: 15,
    padding: 15,
    marginBottom: 15,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 3,
    elevation: 2,
    borderLeftWidth: 4,
    borderLeftColor: COLORS.secondary,
  },
  matchHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  leagueText: {
    fontSize: 12,
    color: COLORS.secondary,
    fontWeight: '600',
    textTransform: 'uppercase',
  },
  dateText: {
    fontSize: 12,
    color: COLORS.accent,
    fontWeight: 'bold',
  },
  matchTeams: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 15,
  },
  teamText: {
    fontSize: 16,
    fontWeight: 'bold',
    color: COLORS.text,
    flex: 1,
    textAlign: 'center',
  },
  vsText: {
    fontSize: 14,
    color: COLORS.textSecondary,
    marginHorizontal: 10,
  },
  analysisBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.primary,
    paddingVertical: 8,
    borderRadius: 10,
  },
  analysisText: {
    color: COLORS.bg,
    fontSize: 12,
    fontWeight: 'bold',
    marginRight: 5,
  },
});
