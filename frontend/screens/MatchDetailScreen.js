import React from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';

export default function MatchDetailScreen({ route }) {
  const { match } = route.params;

  return (
    <ScrollView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.league}>{match.league}</Text>
        <Text style={styles.teams}>{match.homeTeam} vs {match.awayTeam}</Text>
        <Text style={styles.time}>{match.time}</Text>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Bot Analysis</Text>
        <View style={styles.card}>
            <Text style={styles.prediction}>Prediction: {match.analysis.prediction}</Text>
            <Text style={styles.confidence}>Confidence: {match.analysis.confidence}</Text>
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Team Form (Last 5)</Text>
        <View style={styles.row}>
            <View style={styles.statBox}>
                <Text style={styles.teamName}>{match.homeTeam}</Text>
                <Text style={styles.statValue}>{match.analysis.homeForm}</Text>
            </View>
            <View style={styles.statBox}>
                <Text style={styles.teamName}>{match.awayTeam}</Text>
                <Text style={styles.statValue}>{match.analysis.awayForm}</Text>
            </View>
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Head to Head</Text>
        <View style={styles.card}>
            <Text style={styles.text}>{match.analysis.h2h}</Text>
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Key Stats</Text>
        <View style={styles.card}>
            <Text style={styles.text}>Avg Goals: {match.analysis.avgGoals}</Text>
            <Text style={styles.text}>Possession: {match.analysis.possession}</Text>
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5',
  },
  header: {
    backgroundColor: '#fff',
    padding: 20,
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },
  league: {
    fontSize: 14,
    color: '#666',
    marginBottom: 5,
  },
  teams: {
    fontSize: 24,
    fontWeight: 'bold',
    marginBottom: 5,
    textAlign: 'center',
  },
  time: {
    fontSize: 16,
    color: '#tomato',
    fontWeight: '600',
  },
  section: {
    padding: 20,
    paddingBottom: 0,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    marginBottom: 10,
    color: '#333',
  },
  card: {
    backgroundColor: '#fff',
    padding: 15,
    borderRadius: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  prediction: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#2e7d32',
    marginBottom: 5,
  },
  confidence: {
    fontSize: 16,
    color: '#666',
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  statBox: {
    backgroundColor: '#fff',
    padding: 15,
    borderRadius: 10,
    width: '48%',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  teamName: {
    fontWeight: 'bold',
    marginBottom: 5,
  },
  statValue: {
    fontSize: 16,
    color: '#333',
  },
  text: {
    fontSize: 16,
    color: '#444',
    marginBottom: 5,
  },
});
