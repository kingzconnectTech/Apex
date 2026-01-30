import requests
import json
from datetime import datetime

class EspnClient:
    BASE_URL = "http://site.api.espn.com/apis/site/v2/sports"

    def __init__(self):
        self.session = requests.Session()
        self.headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
        }

    def _get(self, url, params=None):
        try:
            response = self.session.get(url, headers=self.headers, params=params)
            response.raise_for_status()
            return response.json()
        except requests.exceptions.RequestException as e:
            print(f"Error fetching {url}: {e}")
            return None

    def get_matches(self, sport, league):
        """
        Get live/current matches for a specific league.
        """
        url = f"{self.BASE_URL}/{sport}/{league}/scoreboard"
        return self._get(url)

    def get_all_leagues_matches(self):
        """
        Fetch matches for a predefined list of popular leagues.
        """
        leagues = [
            ("soccer", "eng.1"),       # Premier League
            ("soccer", "esp.1"),       # La Liga
            ("soccer", "ita.1"),       # Serie A
            ("soccer", "ger.1"),       # Bundesliga
            ("soccer", "fra.1"),       # Ligue 1
            ("soccer", "uefa.champions"), # UCL
            ("soccer", "usa.1"),       # MLS
            ("basketball", "nba"),     # NBA
            ("basketball", "mens-college-basketball"), # NCAA
            ("basketball", "womens-college-basketball"), # NCAA Women
            ("basketball", "wnba"),    # WNBA
        ]
        
        results = {}
        for sport, league in leagues:
            key = f"{sport}/{league}"
            data = self.get_matches(sport, league)
            if data:
                results[key] = data
        return results

    def get_team_details(self, sport, league, team_id):
        """
        Get detailed team info including next/prev matches, record, etc.
        """
        url = f"{self.BASE_URL}/{sport}/{league}/teams/{team_id}"
        return self._get(url, params={"enable": "roster,schedule,stats"})

    def get_team_news(self, sport, league, team_id):
        """
        Get news for a team.
        """
        url = f"{self.BASE_URL}/{sport}/{league}/news"
        return self._get(url, params={"team": team_id})

    def get_standings(self, sport, league):
        """
        Get table/standings.
        """
        url = f"{self.BASE_URL}/{sport}/{league}/standings"
        return self._get(url)

    def get_team_schedule(self, sport, league, team_id):
        """
        Get team schedule (previous and next matches).
        """
        url = f"{self.BASE_URL}/{sport}/{league}/teams/{team_id}/schedule"
        return self._get(url)

    def get_team_statistics(self, sport, league, team_id):
        """
        Get team season statistics.
        """
        url = f"{self.BASE_URL}/{sport}/{league}/teams/{team_id}/statistics"
        return self._get(url)

    def get_match_summary(self, sport, league, event_id):
        """
        Get match summary (box score, stats).
        """
        url = f"{self.BASE_URL}/{sport}/{league}/summary"
        return self._get(url, params={"event": event_id})

    def analyze_team_form(self, sport, league, team_id):
        """
        Calculate/Aggregate form data.
        """
        schedule = self.get_team_schedule(sport, league, team_id)
        if not schedule or 'events' not in schedule:
            return {}

        events = schedule['events']
        form_data = {
            "wins": 0,
            "losses": 0,
            "draws": 0,
            "goals_scored": 0,
            "goals_conceded": 0,
            "match_count": 0,
            "recent_results": [],
            "avg_goals_scored": 0,
            "avg_goals_conceded": 0
        }

        # Process completed events
        for event in events:
            status = event.get('competitions', [{}])[0].get('status', {}).get('type', {}).get('state')
            if status == 'post': # Completed match
                form_data['match_count'] += 1
                
                # Extract score
                competitors = event['competitions'][0]['competitors']
                # find our team
                my_team = next((c for c in competitors if c['id'] == team_id), None)
                opp_team = next((c for c in competitors if c['id'] != team_id), None)
                
                if my_team and opp_team:
                    try:
                        my_score_val = my_team.get('score', {}).get('value')
                        opp_score_val = opp_team.get('score', {}).get('value')
                        
                        if my_score_val is None or opp_score_val is None:
                            continue

                        my_score = int(my_score_val)
                        opp_score = int(opp_score_val)
                        
                        form_data['goals_scored'] += my_score
                        form_data['goals_conceded'] += opp_score
                        
                        result = 'D'
                        if my_score > opp_score:
                            form_data['wins'] += 1
                            result = 'W'
                        elif my_score < opp_score:
                            form_data['losses'] += 1
                            result = 'L'
                        else:
                            form_data['draws'] += 1
                            
                        form_data['recent_results'].append({
                            "date": event.get('date'),
                            "opponent": opp_team['team']['displayName'],
                            "score": f"{my_score}-{opp_score}",
                            "result": result
                        })
                    except (ValueError, TypeError):
                        pass

        if form_data['match_count'] > 0:
            form_data['avg_goals_scored'] = round(form_data['goals_scored'] / form_data['match_count'], 2)
            form_data['avg_goals_conceded'] = round(form_data['goals_conceded'] / form_data['match_count'], 2)

        return form_data

if __name__ == "__main__":
    client = EspnClient()
    
    print("Fetching matches for NBA...")
    nba = client.get_matches("basketball", "nba")
    if nba:
        print(f"Found {len(nba.get('events', []))} matches in NBA")

    print("\nFetching matches for Premier League...")
    epl = client.get_matches("soccer", "eng.1")
    if epl:
        print(f"Found {len(epl.get('events', []))} matches in EPL")
        
    # Example: Get info for a specific team if matches exist
    if epl and epl.get('events'):
        first_event = epl['events'][0]
        competitors = first_event['competitions'][0]['competitors']
        team_id = competitors[0]['id']
        team_name = competitors[0]['team']['displayName']
        
        print(f"\nFetching details for team: {team_name} (ID: {team_id})")
        
        # 1. Team History (Schedule & Results) & Form
        print("Analyzing Team Form...")
        form = client.analyze_team_form("soccer", "eng.1", team_id)
        print(f"Form: {json.dumps(form, indent=2)}")
        
        # 2. Team News
        print("Fetching Team News...")
        news = client.get_team_news("soccer", "eng.1", team_id)
        if news and 'articles' in news:
            print(f"Found {len(news['articles'])} news articles")
            
        # 3. Position in Table
        print("Fetching Standings...")
        standings = client.get_standings("soccer", "eng.1")
        if standings:
            # logic to find team in standings would go here
            print("Standings fetched.")

        # 4. Team Season Stats (Corners, Fouls, etc.)
        print("Fetching Season Statistics...")
        stats = client.get_team_statistics("soccer", "eng.1", team_id)
        if stats:
            print(f"Season stats fetched. Categories: {len(stats.get('stats', []))}")
            # Example: Print first few stat categories to see what's available
            # often includes 'fouls committed', 'yellow cards', etc.
            # parsing them depends on exact structure


