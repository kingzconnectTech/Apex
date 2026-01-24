import React from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { COLORS } from '../constants/colors';

export default function MatchDetailsScreen({ route }) {
  const { match } = route.params || {};

  // Dummy data if not passed (though it should be)
  const matchData = match || {
    homeTeam: 'Team A',
    awayTeam: 'Team B',
    date: 'Today',
    league: 'Premier League',
  };

  return (
    <ScrollView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.league}>{matchData.league}</Text>
        <View style={styles.scoreContainer}>
          <Text style={styles.teamName}>{matchData.homeTeam}</Text>
          <Text style={styles.vs}>VS</Text>
          <Text style={styles.teamName}>{matchData.awayTeam}</Text>
        </View>
        <Text style={styles.date}>{matchData.date}</Text>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Bot Prediction</Text>
        <View style={styles.card}>
          <Text style={styles.predictionText}>
            Apex predicts a win for <Text style={styles.highlight}>{matchData.homeTeam}</Text>
          </Text>
          <Text style={styles.confidence}>Confidence: 85%</Text>
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Team Form</Text>
        <View style={styles.row}>
          <View style={styles.statBox}>
            <Text style={styles.statLabel}>{matchData.homeTeam}</Text>
            <Text style={styles.statValue}>W W L D W</Text>
          </View>
          <View style={styles.statBox}>
            <Text style={styles.statLabel}>{matchData.awayTeam}</Text>
            <Text style={styles.statValue}>L D W L L</Text>
          </View>
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Head to Head</Text>
        <View style={styles.card}>
          <Text style={styles.statText}>{matchData.homeTeam} Wins: 5</Text>
          <Text style={styles.statText}>{matchData.awayTeam} Wins: 2</Text>
          <Text style={styles.statText}>Draws: 3</Text>
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.bg,
  },
  header: {
    backgroundColor: COLORS.cardBg,
    padding: 20,
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: COLORS.primary,
  },
  league: {
    fontSize: 14,
    color: COLORS.secondary,
    marginBottom: 10,
    textTransform: 'uppercase',
    fontWeight: 'bold',
  },
  scoreContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    marginBottom: 10,
  },
  teamName: {
    fontSize: 18,
    fontWeight: 'bold',
    flex: 1,
    textAlign: 'center',
    color: COLORS.text,
  },
  vs: {
    fontSize: 16,
    color: COLORS.textSecondary,
    marginHorizontal: 10,
  },
  date: {
    fontSize: 14,
    color: COLORS.accent,
  },
  section: {
    padding: 20,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    marginBottom: 10,
    color: COLORS.secondary,
  },
  card: {
    backgroundColor: COLORS.cardBg,
    padding: 15,
    borderRadius: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.05)',
  },
  predictionText: {
    fontSize: 16,
    color: COLORS.text,
    marginBottom: 5,
  },
  highlight: {
    fontWeight: 'bold',
    color: COLORS.primary,
  },
  confidence: {
    fontSize: 14,
    color: COLORS.success,
    fontWeight: 'bold',
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  statBox: {
    backgroundColor: COLORS.cardBg,
    padding: 15,
    borderRadius: 10,
    width: '48%',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.05)',
  },
  statLabel: {
    fontSize: 14,
    fontWeight: 'bold',
    marginBottom: 5,
    textAlign: 'center',
    color: COLORS.text,
  },
  statValue: {
    fontSize: 14,
    color: COLORS.accent,
    fontWeight: 'bold',
  },
  statText: {
    fontSize: 14,
    color: COLORS.text,
    marginBottom: 5,
  },
});
