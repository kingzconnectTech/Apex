import React from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, Image, SafeAreaView, ScrollView } from 'react-native';
import { COLORS } from '../constants/colors';
import { Ionicons } from '@expo/vector-icons';

const MARKET_ITEMS = [
  {
    id: '1',
    title: 'Premium Prediction Bot',
    description: 'Advanced AI algorithm with 85% accuracy rate on EPL matches.',
    price: '$9.99/mo',
    icon: 'hardware-chip-outline',
    category: 'Subscription',
  },
  {
    id: '2',
    title: 'VIP Tips Access',
    description: 'Daily high-confidence tips from our expert analysts.',
    price: '$4.99/mo',
    icon: 'star-outline',
    category: 'Subscription',
  },
  {
    id: '3',
    title: 'Ad-Free Experience',
    description: 'Remove all ads from the application forever.',
    price: '$2.99',
    icon: 'close-circle-outline',
    category: 'One-time',
  },
  {
    id: '4',
    title: 'Historical Data Pack',
    description: 'Access 5 years of historical match data and analysis.',
    price: '$14.99',
    icon: 'stats-chart-outline',
    category: 'One-time',
  },
];

export default function MarketScreen() {
  const renderMarketItem = ({ item }) => (
    <TouchableOpacity style={styles.card}>
      <View style={styles.iconContainer}>
        <Ionicons name={item.icon} size={32} color={COLORS.primary} />
      </View>
      
      <View style={styles.cardContent}>
        <View style={styles.cardHeader}>
          <Text style={styles.cardTitle}>{item.title}</Text>
          <View style={styles.categoryBadge}>
            <Text style={styles.categoryText}>{item.category}</Text>
          </View>
        </View>
        
        <Text style={styles.description}>{item.description}</Text>
        
        <View style={styles.footer}>
          <Text style={styles.price}>{item.price}</Text>
          <TouchableOpacity style={styles.buyButton}>
            <Text style={styles.buyButtonText}>Purchase</Text>
          </TouchableOpacity>
        </View>
      </View>
    </TouchableOpacity>
  );

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Marketplace</Text>
        <View style={styles.coinContainer}>
          <Ionicons name="wallet-outline" size={20} color={COLORS.accent} />
          <Text style={styles.coinText}>0 Credits</Text>
        </View>
      </View>
      
      <View style={styles.banner}>
        <Text style={styles.bannerTitle}>Upgrade to Pro</Text>
        <Text style={styles.bannerText}>Unlock all features and get unlimited access to predictions.</Text>
        <TouchableOpacity style={styles.bannerButton}>
          <Text style={styles.bannerButtonText}>Learn More</Text>
        </TouchableOpacity>
      </View>

      <Text style={styles.sectionTitle}>Available Items</Text>
      
      <FlatList
        data={MARKET_ITEMS}
        renderItem={renderMarketItem}
        keyExtractor={item => item.id}
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.bg,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 20,
    backgroundColor: COLORS.bg,
  },
  headerTitle: {
    fontSize: 28,
    fontWeight: 'bold',
    color: COLORS.text,
  },
  coinContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.cardBg,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: COLORS.primary,
  },
  coinText: {
    color: COLORS.accent,
    fontWeight: 'bold',
    marginLeft: 6,
  },
  banner: {
    margin: 20,
    marginTop: 0,
    backgroundColor: COLORS.primary,
    borderRadius: 16,
    padding: 20,
    alignItems: 'center',
    shadowColor: COLORS.secondary,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 5,
    elevation: 5,
  },
  bannerTitle: {
    color: COLORS.white,
    fontSize: 22,
    fontWeight: 'bold',
    marginBottom: 8,
  },
  bannerText: {
    color: COLORS.white,
    textAlign: 'center',
    marginBottom: 16,
    opacity: 0.9,
  },
  bannerButton: {
    backgroundColor: COLORS.accent,
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 20,
  },
  bannerButtonText: {
    color: COLORS.bg,
    fontWeight: 'bold',
  },
  sectionTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    color: COLORS.text,
    marginLeft: 20,
    marginBottom: 10,
  },
  listContent: {
    padding: 20,
    paddingTop: 0,
  },
  card: {
    backgroundColor: COLORS.cardBg,
    borderRadius: 16,
    padding: 16,
    marginBottom: 16,
    flexDirection: 'row',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.05)',
  },
  iconContainer: {
    width: 60,
    height: 60,
    borderRadius: 12,
    backgroundColor: 'rgba(98, 129, 65, 0.1)',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 16,
  },
  cardContent: {
    flex: 1,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 4,
  },
  cardTitle: {
    color: COLORS.text,
    fontSize: 16,
    fontWeight: 'bold',
    flex: 1,
  },
  categoryBadge: {
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    marginLeft: 8,
  },
  categoryText: {
    color: COLORS.textSecondary,
    fontSize: 10,
  },
  description: {
    color: COLORS.textSecondary,
    fontSize: 12,
    marginBottom: 12,
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  price: {
    color: COLORS.accent,
    fontSize: 16,
    fontWeight: 'bold',
  },
  buyButton: {
    backgroundColor: COLORS.secondary,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
  },
  buyButtonText: {
    color: COLORS.white,
    fontWeight: 'bold',
    fontSize: 12,
  },
});
