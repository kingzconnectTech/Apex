import httpx
import json
from datetime import datetime
from cachetools import TTLCache
from typing import Dict, Any, Optional, Tuple

class EspnClient:
    BASE_URL = "http://site.api.espn.com/apis/site/v2/sports"

    # TTLs in seconds
    TTL_TEAM_FORM = 600  # 10 minutes
    TTL_FIXTURES = 300   # 5 minutes
    TTL_H2H = 86400      # 24 hours
    TTL_STANDINGS = 1800 # 30 minutes
    TTL_DEFAULT = 300    # 5 minutes

    def __init__(self):
        # Initialize async client
        self.client = httpx.AsyncClient(
            timeout=30.0,
            headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
            }
        )
        
        # Initialize TTLCache for different data types
        self.cache_team_form: TTLCache[str, Any] = TTLCache(maxsize=1000, ttl=self.TTL_TEAM_FORM)
        self.cache_fixtures: TTLCache[str, Any] = TTLCache(maxsize=100, ttl=self.TTL_FIXTURES)
        self.cache_h2h: TTLCache[str, Any] = TTLCache(maxsize=500, ttl=self.TTL_H2H)
        self.cache_standings: TTLCache[str, Any] = TTLCache(maxsize=50, ttl=self.TTL_STANDINGS)
        self.cache_default: TTLCache[str, Any] = TTLCache(maxsize=2000, ttl=self.TTL_DEFAULT)

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        await self.client.aclose()

    def _make_cache_key(self, url: str, params: Optional[Dict[str, Any]] = None) -> str:
        """Create a unique cache key from URL and params."""
        param_str = json.dumps(params, sort_keys=True) if params else "none"
        return f"{url}:{param_str}"

    async def _get(self, url: str, params: Optional[Dict[str, Any]] = None, cache_type: str = "default") -> Optional[Dict[str, Any]]:
        """Async get with caching based on type."""
        cache_key = self._make_cache_key(url, params)
        
        # Select appropriate cache
        cache = self._get_cache_for_type(cache_type)
        
        # Check cache first
        if cache_key in cache:
            return cache[cache_key]

        try:
            response = await self.client.get(url, params=params)
            response.raise_for_status()
            data = response.json()
            
            # Store in cache
            cache[cache_key] = data
            return data
        except httpx.HTTPError as e:
            print(f"Error fetching {url}: {e}")
            return None

    def _get_cache_for_type(self, cache_type: str):
        """Return the appropriate cache based on type."""
        if cache_type == "team_form":
            return self.cache_team_form
        elif cache_type == "fixtures":
            return self.cache_fixtures
        elif cache_type == "h2h":
            return self.cache_h2h
        elif cache_type == "standings":
            return self.cache_standings
        else:
            return self.cache_default

    async def get_matches(self, sport: str, league: str) -> Optional[Dict[str, Any]]:
        """Get live/current matches for a specific league."""
        url = f"{self.BASE_URL}/{sport}/{league}/scoreboard"
        return await self._get(url, cache_type="fixtures")

    async def get_all_leagues_matches(self) -> Dict[str, Any]:
        """Fetch matches for a predefined list of popular leagues in parallel."""
        leagues = [
            # Soccer
            ("soccer", "eng.1"),       # Premier League
            ("soccer", "eng.2"),       # Championship
            ("soccer", "eng.3"),       # League One
            ("soccer", "esp.1"),       # La Liga
            ("soccer", "esp.2"),       # La Liga 2
            ("soccer", "ita.1"),       # Serie A
            ("soccer", "ita.2"),       # Serie B
            ("soccer", "ger.1"),       # Bundesliga
            ("soccer", "ger.2"),       # 2. Bundesliga
            ("soccer", "fra.1"),       # Ligue 1
            ("soccer", "fra.2"),       # Ligue 2
            ("soccer", "ned.1"),       # Eredivisie
            ("soccer", "por.1"),       # Liga Portugal
            ("soccer", "por.2"),       # Liga Portugal 2
            ("soccer", "tur.1"),       # Super Lig
            ("soccer", "rus.1"),       # Russian Premier League
            ("soccer", "ukr.1"),       # Ukrainian Premier League
            ("soccer", "bel.1"),       # Belgian Pro League
            ("soccer", "sct.1"),       # Scottish Premiership
            ("soccer", "aut.1"),       # Austrian Bundesliga
            ("soccer", "grc.1"),       # Super League Greece
            ("soccer", "dnk.1"),       # Danish Superliga
            ("soccer", "swe.1"),       # Allsvenskan
            ("soccer", "nor.1"),       # Eliteserien
            ("soccer", "cze.1"),       # Czech First League
            ("soccer", "hun.1"),       # Nemzeti Bajnokság I
            ("soccer", "pol.1"),       # Ekstraklasa
            ("soccer", "mex.1"),       # Liga MX
            ("soccer", "mex.2"),       # Liga de Expansión MX
            ("soccer", "bra.1"),       # Brasileirão Série A
            ("soccer", "bra.2"),       # Brasileirão Série B
            ("soccer", "arg.1"),       # Argentine Primera División
            ("soccer", "chl.1"),       # Chilean Primera División
            ("soccer", "col.1"),       # Categoría Primera A
            ("soccer", "per.1"),       # Peruvian Liga 1
            ("soccer", "uru.1"),       # Uruguayan Primera División
            ("soccer", "usa.1"),       # MLS
            ("soccer", "usa.2"),       # USL Championship
            ("soccer", "usa.nwsl"),    # NWSL
            ("soccer", "can.1"),       # Canadian Premier League
            ("soccer", "jpn.1"),       # J1 League
            ("soccer", "jpn.2"),       # J2 League
            ("soccer", "kor.1"),       # K League 1
            ("soccer", "chn.1"),       # Chinese Super League
            ("soccer", "aus.1"),       # A-League Men
            ("soccer", "aus.2"),       # A-League Women
            ("soccer", "saudi.1"),     # Saudi Pro League
            ("soccer", "uae.1"),       # UAE Pro League
            ("soccer", "qat.1"),       # Qatar Stars League
            ("soccer", "egy.1"),       # Egyptian Premier League
            ("soccer", "ngr.1"),       # Nigerian Professional Football League
            ("soccer", "conmebol.libertadores"), # Copa Libertadores
            ("soccer", "conmebol.sudamericana"), # Copa Sudamericana
            ("soccer", "conmebol.copaamerica"), # Copa America
            ("soccer", "concacaf.goldcup"), # Gold Cup
            ("soccer", "concacaf.champions"), # CONCACAF Champions Cup
            ("soccer", "concacaf.nationsleague"), # CONCACAF Nations League
            ("soccer", "uefa.champions"), # Champions League
            ("soccer", "uefa.europa"), # Europa League
            ("soccer", "uefa.europaconference"), # Europa Conference League
            ("soccer", "uefa.nations"), # Nations League
            ("soccer", "uefa.euro"),   # UEFA European Championship
            ("soccer", "uefa.womenseuro"), # UEFA Women's Championship
            ("soccer", "fifa.world"),  # FIFA World Cup
            ("soccer", "fifa.womens-world-cup"), # FIFA Women's World Cup
            ("soccer", "fifa.friendly"), # International Friendlies
            
            # Basketball
            ("basketball", "nba"),     # NBA
            ("basketball", "nba-g-league"), # NBA G League
            ("basketball", "wnba"),    # WNBA
            ("basketball", "mens-college-basketball"), # NCAA Men
            ("basketball", "womens-college-basketball"), # NCAA Women
            ("basketball", "euroleague"), # EuroLeague
            ("basketball", "eurocup"), # EuroCup
            ("basketball", "eurochamp"), # FIBA EuroBasket
            ("basketball", "fibawc"),  # FIBA Basketball World Cup
            ("basketball", "acb"),     # Liga ACB (Spain)
            ("basketball", "legabasket"), # Lega Basket Serie A (Italy)
            ("basketball", "bbl"),     # Basketball Bundesliga (Germany)
            ("basketball", "betclic"), # Betclic Élite (France)
            ("basketball", "australia.nbl"), # NBL Australia
            ("basketball", "cba"),     # CBA (China)
            ("basketball", "bcl"),     # Basketball Champions League
            ("basketball", "nbca"),    # NBA Summer League
            
            # Tennis
            ("tennis", "grand-slam"),  # Grand Slams
            ("tennis", "atp"),         # ATP Tour
            ("tennis", "atp.masters"), # ATP Masters 1000
            ("tennis", "atp.500"),     # ATP 500
            ("tennis", "atp.250"),     # ATP 250
            ("tennis", "atp.challenger"), # ATP Challenger Tour
            ("tennis", "atp.finals"),  # ATP Finals
            ("tennis", "wta"),         # WTA Tour
            ("tennis", "wta.premier"), # WTA Premier
            ("tennis", "wta.1000"),    # WTA 1000
            ("tennis", "wta.500"),     # WTA 500
            ("tennis", "wta.250"),     # WTA 250
            ("tennis", "wta.125"),     # WTA 125
            ("tennis", "wta.finals"),  # WTA Finals
            ("tennis", "itf"),         # ITF Tour
            ("tennis", "davis-cup"),   # Davis Cup
            ("tennis", "billie-jean-king-cup"), # Billie Jean King Cup
            ("tennis", "laver-cup"),   # Laver Cup
            ("tennis", "hopman-cup"),  # Hopman Cup
            ("tennis", "next-gen-atp-finals"), # Next Gen ATP Finals
        ]
        
        # Fetch all leagues in parallel
        async def fetch_league(sport_league: Tuple[str, str]) -> Tuple[str, Optional[Dict[str, Any]]]:
            s, l = sport_league
            key = f"{s}/{l}"
            data = await self.get_matches(s, l)
            return key, data
        
        import asyncio
        tasks = [fetch_league(league) for league in leagues]
        results_list = await asyncio.gather(*tasks, return_exceptions=True)
        
        results = {}
        for item in results_list:
            if isinstance(item, Exception):
                continue
            key, data = item
            if data:
                results[key] = data
        return results

    async def get_team_details(self, sport: str, league: str, team_id: str) -> Optional[Dict[str, Any]]:
        """Get detailed team info including next/prev matches, record, etc."""
        url = f"{self.BASE_URL}/{sport}/{league}/teams/{team_id}"
        return await self._get(url, params={"enable": "roster,schedule,stats"})

    async def get_team_news(self, sport: str, league: str, team_id: str) -> Optional[Dict[str, Any]]:
        """Get news for a team."""
        url = f"{self.BASE_URL}/{sport}/{league}/news"
        return await self._get(url, params={"team": team_id})

    async def get_standings(self, sport: str, league: str) -> Optional[Dict[str, Any]]:
        """Get table/standings."""
        url = f"{self.BASE_URL}/{sport}/{league}/standings"
        return await self._get(url, cache_type="standings")

    async def get_team_schedule(self, sport: str, league: str, team_id: str) -> Optional[Dict[str, Any]]:
        """Get team schedule (previous and next matches)."""
        url = f"{self.BASE_URL}/{sport}/{league}/teams/{team_id}/schedule"
        return await self._get(url)

    async def get_team_statistics(self, sport: str, league: str, team_id: str) -> Optional[Dict[str, Any]]:
        """Get team season statistics."""
        url = f"{self.BASE_URL}/{sport}/{league}/teams/{team_id}/statistics"
        return await self._get(url)

    async def get_match_summary(self, sport: str, league: str, event_id: str) -> Optional[Dict[str, Any]]:
        """Get match summary (box score, stats)."""
        url = f"{self.BASE_URL}/{sport}/{league}/summary"
        return await self._get(url, params={"event": event_id})

    async def analyze_team_form(self, sport: str, league: str, team_id: str) -> Dict[str, Any]:
        """Calculate/Aggregate form data."""
        # Use a unique cache key for this analysis
        cache_key = f"form:{sport}:{league}:{team_id}"
        if cache_key in self.cache_team_form:
            return self.cache_team_form[cache_key]
            
        schedule = await self.get_team_schedule(sport, league, team_id)
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

        # Process completed and live events
        for event in events:
            status_obj = event.get('competitions', [{}])[0].get('status', {}).get('type', {})
            state = status_obj.get('state')
            
            # 'post' = finished, 'in' = live
            if state in ['post', 'in']:
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
                            "result": result,
                            "is_live": state == 'in'
                        })
                    except (ValueError, TypeError):
                        pass

        if form_data['match_count'] > 0:
            form_data['avg_goals_scored'] = round(form_data['goals_scored'] / form_data['match_count'], 2)
            form_data['avg_goals_conceded'] = round(form_data['goals_conceded'] / form_data['match_count'], 2)

        self.cache_team_form[cache_key] = form_data
        return form_data
        
    async def analyze_athlete_form(self, sport: str, league: str, athlete_id: str) -> Dict[str, Any]:
        """Analyze tennis player form, including surface-specific performance, recent results, streaks."""
        cache_key = f"athlete_form:{sport}:{league}:{athlete_id}"
        if cache_key in self.cache_team_form:
            return self.cache_team_form[cache_key]
            
        if sport != "tennis":
            return {}
            
        # Get tennis matches (from scoreboard)
        scoreboard = await self.get_matches(sport, league)
        if not scoreboard or 'events' not in scoreboard:
            return {}
            
        form_data = {
            "wins": 0,
            "losses": 0,
            "match_count": 0,
            "recent_results": [],
            "surface_wins": {},  # surface: wins
            "surface_losses": {},  # surface: losses
            "win_streak": 0,
            "loss_streak": 0,
            "injury_status": "healthy"  # default if not available
        }
        
        for event in scoreboard['events']:
            status_obj = event.get('competitions', [{}])[0].get('status', {}).get('type', {})
            state = status_obj.get('state')
            
            if state not in ['post', 'in']:
                continue
                
            competitors = event.get('competitions', [{}])[0].get('competitors', [])
            if len(competitors) < 2:
                continue
                
            # Find if athlete is in this match
            my_player = None
            opp_player = None
            for c in competitors:
                if c.get('id') == athlete_id:
                    my_player = c
                else:
                    opp_player = c
                    
            if not my_player or not opp_player:
                continue
                
            form_data['match_count'] += 1
            
            # Get surface
            surface = event.get('competitions', [{}])[0].get('venue', {}).get('surface', 'unknown')
            if surface not in form_data['surface_wins']:
                form_data['surface_wins'][surface] = 0
                form_data['surface_losses'][surface] = 0
                
            # Get score
            try:
                my_score_val = my_player.get('score', {}).get('value')
                opp_score_val = opp_player.get('score', {}).get('value')
                if my_score_val is None or opp_score_val is None:
                    continue
                    
                my_score = int(my_score_val)
                opp_score = int(opp_score_val)
                
                result = 'L'
                if my_score > opp_score:
                    form_data['wins'] += 1
                    form_data['surface_wins'][surface] += 1
                    result = 'W'
                else:
                    form_data['losses'] += 1
                    form_data['surface_losses'][surface] += 1
                    
                # Update streaks
                if result == 'W':
                    if form_data['loss_streak'] > 0:
                        form_data['loss_streak'] = 0
                    form_data['win_streak'] += 1
                else:
                    if form_data['win_streak'] > 0:
                        form_data['win_streak'] = 0
                    form_data['loss_streak'] += 1
                    
                form_data['recent_results'].append({
                    "date": event.get('date'),
                    "opponent": opp_player.get('team', {}).get('displayName', 'Unknown'),
                    "surface": surface,
                    "score": f"{my_score}-{opp_score}",
                    "result": result,
                    "is_live": state == 'in'
                })
            except (ValueError, TypeError):
                pass
                
        self.cache_team_form[cache_key] = form_data
        return form_data
        
    async def get_head_to_head(self, sport: str, league: str, athlete1_id: str, athlete2_id: str) -> Dict[str, Any]:
        """Get head-to-head record between two players/teams."""
        cache_key = f"h2h:{sport}:{league}:{athlete1_id}:{athlete2_id}"
        if cache_key in self.cache_h2h:
            return self.cache_h2h[cache_key]
            
        scoreboard = await self.get_matches(sport, league)
        if not scoreboard or 'events' not in scoreboard:
            h2h = {"wins_athlete1": 0, "wins_athlete2": 0, "matches": []}
            self.cache_h2h[cache_key] = h2h
            return h2h
            
        h2h = {
            "wins_athlete1": 0,
            "wins_athlete2": 0,
            "matches": []
        }
        
        for event in scoreboard['events']:
            status_obj = event.get('competitions', [{}])[0].get('status', {}).get('type', {})
            state = status_obj.get('state')
            if state != 'post':
                continue
                
            competitors = event.get('competitions', [{}])[0].get('competitors', [])
            if len(competitors) < 2:
                continue
                
            ids = [c.get('id') for c in competitors]
            if athlete1_id not in ids or athlete2_id not in ids:
                continue
                
            # Process match
            try:
                c1 = next((c for c in competitors if c['id'] == athlete1_id), None)
                c2 = next((c for c in competitors if c['id'] == athlete2_id), None)
                if not c1 or not c2:
                    continue
                    
                score1 = int(c1.get('score', {}).get('value', 0))
                score2 = int(c2.get('score', {}).get('value', 0))
                
                if score1 > score2:
                    h2h['wins_athlete1'] += 1
                else:
                    h2h['wins_athlete2'] += 1
                    
                h2h['matches'].append({
                    "date": event.get('date'),
                    "score": f"{score1}-{score2}",
                    "winner": athlete1_id if score1 > score2 else athlete2_id
                })
            except (ValueError, TypeError):
                pass
                
        self.cache_h2h[cache_key] = h2h
        return h2h
        
    async def get_live_matches(self, sport: str, league: str) -> list:
        """Get all currently live matches for a sport/league."""
        scoreboard = await self.get_matches(sport, league)
        if not scoreboard or 'events' not in scoreboard:
            return []
            
        live_matches = []
        for event in scoreboard['events']:
            status = event.get('competitions', [{}])[0].get('status', {})
            if status.get('type', {}).get('state') == 'in':
                live_matches.append(event)
                
        return live_matches
        
    async def extract_match_stats_from_summary(self, match_summary: Dict[str, Any]):
        """Extract relevant stats (goal kicks, throw-ins if available) from match summary."""
        home_stats = {}
        away_stats = {}
        try:
            # ESPN typically puts stats in boxscore or teams sections
            if "boxscore" in match_summary and "teams" in match_summary["boxscore"]:
                for idx, team in enumerate(match_summary["boxscore"]["teams"]):
                    stats_dict = {}
                    for stat in team.get("statistics", []):
                        stats_dict[stat.get("name", "").lower()] = stat.get("displayValue", "")
                    if idx ==0:
                        home_stats = stats_dict
                    else:
                        away_stats = stats_dict
        except Exception as e:
            print(f"Error extracting match stats: {e}")
            
        return {"home": home_stats, "away": away_stats}

if __name__ == "__main__":
    import asyncio
    async def main():
        async with EspnClient() as client:
            print("Fetching matches for NBA...")
            nba = await client.get_matches("basketball", "nba")
            if nba:
                print(f"Found {len(nba.get('events', []))} matches in NBA")

            print("\nFetching matches for Premier League...")
            epl = await client.get_matches("soccer", "eng.1")
            if epl:
                print(f"Found {len(epl.get('events', []))} matches in EPL")
                
    asyncio.run(main())
