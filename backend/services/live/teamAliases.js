/**
 * live/teamAliases.js
 *
 * Phase 1 — team alias table (DATA ONLY, no logic).
 *
 * Bookmaker slugs are short: "man-utd", "spurs", "la-lakers". Provider names are
 * long: "Manchester United", "Tottenham Hotspur", "Los Angeles Lakers". This
 * file maps every spelling we know about onto one canonical key per team.
 *
 * Keys are produced by the shared normaliser in ./teamNormalize.js, which wraps
 * providers/normalizer._normalizeTeamName: lowercase, accents stripped,
 * punctuation removed, club suffixes (fc/cf/sc/ac/if/sk/bk/afc) dropped.
 *
 * To add a team: append one entry with a `label` and any number of `aliases`.
 * The canonical key is derived from `label` — never hand-write it.
 *
 * `sport` scoping is required: "spurs" is Tottenham Hotspur in soccer and the
 * San Antonio Spurs in basketball; "wolves" is Wolverhampton Wanderers vs the
 * Minnesota Timberwolves. A lookup that cannot be resolved by sport is treated
 * as ambiguous and returns null rather than guessing.
 *
 * @typedef {{ label: string, league?: string, aliases?: string[] }} TeamAlias
 */

/** @type {{ soccer: TeamAlias[], basketball: TeamAlias[] }} */
const TEAMS = {
  soccer: [
    // England
    { label: 'Manchester United', league: 'eng.1', aliases: ['man utd', 'man united', 'manchester utd', 'utd', 'mun'] },
    { label: 'Manchester City', league: 'eng.1', aliases: ['man city', 'mancity'] },
    { label: 'Liverpool', league: 'eng.1' },
    { label: 'Arsenal', league: 'eng.1', aliases: ['gunners'] },
    { label: 'Chelsea', league: 'eng.1' },
    { label: 'Tottenham Hotspur', league: 'eng.1', aliases: ['spurs', 'tottenham'] },
    { label: 'Newcastle United', league: 'eng.1', aliases: ['newcastle'] },
    { label: 'Aston Villa', league: 'eng.1', aliases: ['villa'] },
    { label: 'Everton', league: 'eng.1' },
    { label: 'West Ham United', league: 'eng.1', aliases: ['west ham'] },
    { label: 'Brighton & Hove Albion', league: 'eng.1', aliases: ['brighton'] },
    { label: 'Crystal Palace', league: 'eng.1', aliases: ['palace'] },
    { label: 'Wolverhampton Wanderers', league: 'eng.1', aliases: ['wolves', 'wolverhampton'] },
    { label: 'Nottingham Forest', league: 'eng.1', aliases: ['forest', 'nottingham'] },
    { label: 'Fulham', league: 'eng.1' },
    { label: 'Brentford', league: 'eng.1' },
    { label: 'AFC Bournemouth', league: 'eng.1', aliases: ['bournemouth'] },
    { label: 'Leicester City', league: 'eng.1', aliases: ['leicester'] },
    { label: 'Leeds United', league: 'eng.1', aliases: ['leeds'] },
    { label: 'Burnley', league: 'eng.1' },
    { label: 'Sunderland', league: 'eng.1' },
    // Spain
    { label: 'Real Madrid', league: 'esp.1', aliases: ['realmadrid', 'madrid cf'] },
    { label: 'Barcelona', league: 'esp.1', aliases: ['barca', 'fc barcelona'] },
    { label: 'Atletico Madrid', league: 'esp.1', aliases: ['atleti', 'atletico'] },
    { label: 'Sevilla', league: 'esp.1' },
    { label: 'Valencia', league: 'esp.1' },
    { label: 'Real Betis', league: 'esp.1', aliases: ['betis'] },
    { label: 'Real Sociedad', league: 'esp.1', aliases: ['sociedad'] },
    { label: 'Athletic Bilbao', league: 'esp.1', aliases: ['athletic', 'bilbao'] },
    { label: 'Villarreal', league: 'esp.1' },
    { label: 'Celta Vigo', league: 'esp.1', aliases: ['celta'] },
    { label: 'Espanyol', league: 'esp.1' },
    { label: 'Getafe', league: 'esp.1' },
    { label: 'Osasuna', league: 'esp.1' },
    { label: 'Mallorca', league: 'esp.1' },
    { label: 'Rayo Vallecano', league: 'esp.1', aliases: ['rayo'] },
    { label: 'Girona', league: 'esp.1' },
    { label: 'Deportivo Alaves', league: 'esp.1', aliases: ['alaves'] },
    // Italy
    { label: 'Juventus', league: 'ita.1', aliases: ['juve'] },
    { label: 'Inter Milan', league: 'ita.1', aliases: ['inter', 'internazionale'] },
    { label: 'AC Milan', league: 'ita.1', aliases: ['milan', 'acmilan'] },
    { label: 'Napoli', league: 'ita.1' },
    { label: 'AS Roma', league: 'ita.1', aliases: ['roma'] },
    { label: 'Lazio', league: 'ita.1' },
    { label: 'Atalanta', league: 'ita.1' },
    { label: 'Fiorentina', league: 'ita.1' },
    { label: 'Torino', league: 'ita.1' },
    { label: 'Bologna', league: 'ita.1' },
    { label: 'Genoa', league: 'ita.1', aliases: ['genoa cfc'] },
    { label: 'Udinese', league: 'ita.1' },
    { label: 'Cagliari', league: 'ita.1' },
    { label: 'Hellas Verona', league: 'ita.1', aliases: ['verona'] },
    { label: 'Empoli', league: 'ita.1' },
    { label: 'Lecce', league: 'ita.1' },
    { label: 'Parma', league: 'ita.1' },
    { label: 'Como', league: 'ita.1' },
    // Germany
    { label: 'Bayern Munich', league: 'ger.1', aliases: ['bayern', 'bayern munchen'] },
    { label: 'Borussia Dortmund', league: 'ger.1', aliases: ['dortmund', 'bvb'] },
    { label: 'RB Leipzig', league: 'ger.1', aliases: ['leipzig'] },
    { label: 'Bayer Leverkusen', league: 'ger.1', aliases: ['leverkusen'] },
    { label: 'Eintracht Frankfurt', league: 'ger.1', aliases: ['frankfurt', 'eintracht'] },
    { label: 'Borussia Monchengladbach', league: 'ger.1', aliases: ['gladbach', 'monchengladbach'] },
    { label: 'VfB Stuttgart', league: 'ger.1', aliases: ['stuttgart'] },
    { label: 'VfL Wolfsburg', league: 'ger.1', aliases: ['wolfsburg'] },
    { label: 'Union Berlin', league: 'ger.1' },
    { label: 'SC Freiburg', league: 'ger.1', aliases: ['freiburg'] },
    { label: 'TSG Hoffenheim', league: 'ger.1', aliases: ['hoffenheim'] },
    { label: 'Werder Bremen', league: 'ger.1', aliases: ['werder'] },
    { label: 'Mainz 05', league: 'ger.1', aliases: ['mainz'] },
    { label: 'FC Augsburg', league: 'ger.1', aliases: ['augsburg'] },
    { label: 'FC St. Pauli', league: 'ger.1', aliases: ['st pauli', 'pauli'] },
    { label: '1. FC Heidenheim', league: 'ger.1', aliases: ['heidenheim'] },
    // France
    { label: 'Paris Saint-Germain', league: 'fra.1', aliases: ['psg', 'paris sg', 'paris'] },
    { label: 'Olympique Marseille', league: 'fra.1', aliases: ['marseille'] },
    { label: 'Olympique Lyonnais', league: 'fra.1', aliases: ['lyon', 'olympique lyon'] },
    { label: 'AS Monaco', league: 'fra.1', aliases: ['monaco'] },
    { label: 'Lille OSC', league: 'fra.1', aliases: ['lille', 'losc'] },
    { label: 'Stade Rennais', league: 'fra.1', aliases: ['rennes'] },
    { label: 'OGC Nice', league: 'fra.1', aliases: ['nice'] },
    { label: 'RC Lens', league: 'fra.1', aliases: ['lens'] },
    { label: 'RC Strasbourg', league: 'fra.1', aliases: ['strasbourg'] },
    { label: 'FC Nantes', league: 'fra.1', aliases: ['nantes'] },
    { label: 'Toulouse FC', league: 'fra.1', aliases: ['toulouse'] },
    { label: 'Stade Brestois', league: 'fra.1', aliases: ['brest'] },
    { label: 'Stade de Reims', league: 'fra.1', aliases: ['reims'] },
    { label: 'Le Havre AC', league: 'fra.1', aliases: ['le havre'] },
    { label: 'AS Saint-Etienne', league: 'fra.1', aliases: ['saint etienne', 'st etienne'] },
    // Other European clubs
    { label: 'Ajax', aliases: ['ajax amsterdam'] },
    { label: 'PSV Eindhoven', aliases: ['psv'] },
    { label: 'Feyenoord', aliases: ['feyenoord rotterdam'] },
    { label: 'SL Benfica', aliases: ['benfica'] },
    { label: 'FC Porto', aliases: ['porto'] },
    { label: 'Sporting CP', aliases: ['sporting lisbon', 'sporting'] },
    { label: 'Celtic', aliases: ['celtic glasgow'] },
    { label: 'Rangers', aliases: ['glasgow rangers'] },
    { label: 'Galatasaray' },
    { label: 'Fenerbahce' },
    { label: 'Besiktas' },
    { label: 'Trabzonspor' },
    { label: 'Istanbul Basaksehir', aliases: ['basaksehir', 'istanbul bb'] },
    { label: 'Olympiacos' },
    { label: 'Panathinaikos' },
    { label: 'Red Star Belgrade', aliases: ['crvena zvezda', 'red star'] },
    { label: 'Dinamo Zagreb' },
    { label: 'FC Copenhagen', aliases: ['copenhagen', 'kobenhavn'] },
    { label: 'Malmo FF', aliases: ['malmo'] },
    { label: 'Rosenborg' },
    { label: 'SC Braga', aliases: ['braga'] },
  ],

  basketball: [
    // NBA
    { label: 'Atlanta Hawks', league: 'nba', aliases: ['hawks', 'atl'] },
    { label: 'Boston Celtics', league: 'nba', aliases: ['celtics', 'bos'] },
    { label: 'Brooklyn Nets', league: 'nba', aliases: ['nets', 'bkn'] },
    { label: 'Charlotte Hornets', league: 'nba', aliases: ['hornets', 'cha'] },
    { label: 'Chicago Bulls', league: 'nba', aliases: ['bulls', 'chi'] },
    { label: 'Cleveland Cavaliers', league: 'nba', aliases: ['cavaliers', 'cavs', 'cle'] },
    { label: 'Dallas Mavericks', league: 'nba', aliases: ['mavericks', 'mavs', 'dal'] },
    { label: 'Denver Nuggets', league: 'nba', aliases: ['nuggets', 'den'] },
    { label: 'Detroit Pistons', league: 'nba', aliases: ['pistons', 'det'] },
    { label: 'Golden State Warriors', league: 'nba', aliases: ['warriors', 'gsw'] },
    { label: 'Houston Rockets', league: 'nba', aliases: ['rockets', 'hou'] },
    { label: 'Indiana Pacers', league: 'nba', aliases: ['pacers', 'ind'] },
    { label: 'Los Angeles Clippers', league: 'nba', aliases: ['la clippers', 'clippers', 'lac'] },
    { label: 'Los Angeles Lakers', league: 'nba', aliases: ['la lakers', 'lakers', 'lal'] },
    { label: 'Memphis Grizzlies', league: 'nba', aliases: ['grizzlies', 'mem'] },
    { label: 'Miami Heat', league: 'nba', aliases: ['heat', 'mia'] },
    { label: 'Milwaukee Bucks', league: 'nba', aliases: ['bucks', 'mil'] },
    { label: 'Minnesota Timberwolves', league: 'nba', aliases: ['timberwolves', 'wolves', 'min'] },
    { label: 'New Orleans Pelicans', league: 'nba', aliases: ['pelicans', 'nop'] },
    { label: 'New York Knicks', league: 'nba', aliases: ['knicks', 'nyk'] },
    { label: 'Oklahoma City Thunder', league: 'nba', aliases: ['thunder', 'okc', 'oklahoma city'] },
    { label: 'Orlando Magic', league: 'nba', aliases: ['magic', 'orl'] },
    { label: 'Philadelphia 76ers', league: 'nba', aliases: ['76ers', 'sixers', 'phi'] },
    { label: 'Phoenix Suns', league: 'nba', aliases: ['suns', 'phx'] },
    { label: 'Portland Trail Blazers', league: 'nba', aliases: ['trail blazers', 'blazers', 'por'] },
    { label: 'Sacramento Kings', league: 'nba', aliases: ['kings', 'sac'] },
    { label: 'San Antonio Spurs', league: 'nba', aliases: ['spurs', 'sas', 'san antonio'] },
    { label: 'Toronto Raptors', league: 'nba', aliases: ['raptors', 'tor'] },
    { label: 'Utah Jazz', league: 'nba', aliases: ['jazz', 'uta'] },
    { label: 'Washington Wizards', league: 'nba', aliases: ['wizards', 'was'] },
    // WNBA
    { label: 'Las Vegas Aces', league: 'wnba', aliases: ['aces', 'las vegas'] },
    { label: 'New York Liberty', league: 'wnba', aliases: ['liberty'] },
    { label: 'Minnesota Lynx', league: 'wnba', aliases: ['lynx'] },
    { label: 'Connecticut Sun', league: 'wnba', aliases: ['sun'] },
    { label: 'Seattle Storm', league: 'wnba', aliases: ['storm'] },
    { label: 'Chicago Sky', league: 'wnba', aliases: ['sky'] },
    { label: 'Indiana Fever', league: 'wnba', aliases: ['fever'] },
    { label: 'Atlanta Dream', league: 'wnba', aliases: ['dream'] },
    { label: 'Dallas Wings', league: 'wnba', aliases: ['wings'] },
    { label: 'Washington Mystics', league: 'wnba', aliases: ['mystics'] },
    { label: 'Los Angeles Sparks', league: 'wnba', aliases: ['sparks'] },
    { label: 'Phoenix Mercury', league: 'wnba', aliases: ['mercury'] },
    { label: 'Golden State Valkyries', league: 'wnba', aliases: ['valkyries'] },
  ],
};

module.exports = { TEAMS };
