package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/bwmarrin/discordgo"
)

const (
	version                = "0.2.0-go"
	defaultConfigPath      = "config.json"
	defaultTracksPath      = "data/tracks.json"
	defaultTokenTTL        = 10 * time.Minute
	defaultMaxSeenIDs      = 5000
	defaultStartupPageSize = 100
	defaultStartupMaxPages = 50
	maxPriorityRepeats     = 5
	uiEventPrefix          = "METRACKER_EVENT "
	notifyOnAll            = "all"
	notifyOnPriority       = "priority"
)

var (
	rarityOrder = []string{"Mythic", "Legendary", "Epic", "Rare", "Uncommon", "Common"}
	meToHowRare = map[string]string{
		"great__goats":   "greatgoats",
		"undead_genesis": "undead_genesis",
		"candies":        "candies",
		"morbie":         "morbie",
	}
	symbolPattern = regexp.MustCompile(`magiceden\.io\/marketplace\/([\w_\-]+)`)
)

type Config struct {
	DiscordToken             string `json:"DISCORD_TOKEN"`
	DiscordChannelID         string `json:"DISCORD_CHANNEL_ID"`
	ClientID                 string `json:"CLIENT_ID"`
	GuildID                  string `json:"GUILD_ID"`
	RoundRobinTickMS         int    `json:"ROUND_ROBIN_TICK_MS"`
	BackoffMS                int    `json:"BACKOFF_MS"`
	StartupListingsPageLimit int    `json:"STARTUP_LISTINGS_PAGE_LIMIT"`
	StartupListingsMaxPages  int    `json:"STARTUP_LISTINGS_MAX_PAGES"`
	OwnerID                  string `json:"OWNER_ID"`
	TestMessageDeleteSeconds int    `json:"TEST_MESSAGE_DELETE_SECONDS"`
	TokenMetadataTTLMS       int    `json:"TOKEN_METADATA_TTL_MS"`
	MaxSeenIDs               int    `json:"MAX_SEEN_IDS"`
	PriorityMentionOwner     bool   `json:"PRIORITY_MENTION_OWNER"`
}

type CollectionTrack struct {
	MaxPrice          *float64            `json:"max_price,omitempty"`
	MinRarity         string              `json:"min_rarity,omitempty"`
	SupplyOverride    *int                `json:"supply_override,omitempty"`
	Traits            map[string][]string `json:"traits,omitempty"`
	TraitMatch        string              `json:"trait_match,omitempty"`
	NotifyOn          string              `json:"notify_on,omitempty"`
	TraitAlertRepeats int                 `json:"trait_alert_repeats,omitempty"`
}

type Tracks struct {
	Collections      map[string]CollectionTrack `json:"collections"`
	SalesCollections map[string]CollectionTrack `json:"sales_collections"`
}

type metadataCacheEntry struct {
	CachedAt time.Time
	Data     tokenMetadataPayload
}

type pollStatus struct {
	StartedAt    time.Time
	LastPollAt   time.Time
	LastSuccess  time.Time
	LastError    string
	LastTask     string
	LastBackoff  time.Time
	DynamicTick  time.Duration
	BackoffUntil time.Time
}

type tracker struct {
	cfg              Config
	session          *discordgo.Session
	httpClient       *http.Client
	mu               sync.Mutex
	seenListings     []string
	seenListingSet   map[string]struct{}
	seenSales        []string
	seenSalesSet     map[string]struct{}
	collectionSupply map[string]int
	howRareCache     map[string]map[string]int
	tokenMetadata    map[string]metadataCacheEntry
	status           pollStatus
	roundRobinIndex  int
}

type magicEdenCollection struct {
	Image string `json:"image"`
	Stats struct {
		ListedCount *int `json:"listedCount"`
		Supply      *int `json:"supply"`
	} `json:"stats"`
}

type listingActivity struct {
	ID          string `json:"id"`
	Type        string `json:"type"`
	TokenMint   string `json:"tokenMint"`
	Mint        string `json:"mint"`
	Price       any    `json:"price"`
	PriceSol    any    `json:"priceSol"`
	BuyNowPrice any    `json:"buyNowPrice"`
	BlockTime   any    `json:"blockTime"`
	Image       string `json:"image"`
	Img         string `json:"img"`
	Extra       struct {
		Img         string  `json:"img"`
		HowRareRank any     `json:"howrare_rank"`
		Image       string  `json:"image"`
		Attributes  []trait `json:"attributes"`
	} `json:"extra"`
	Rarity struct {
		MeInstant struct {
			Rank any `json:"rank"`
		} `json:"meInstant"`
		HowRare struct {
			Rank any `json:"rank"`
		} `json:"howrare"`
		Rank any `json:"rank"`
	} `json:"rarity"`
	Token struct {
		Name       string  `json:"name"`
		Title      string  `json:"title"`
		Image      string  `json:"image"`
		Collection string  `json:"collection"`
		Attributes []trait `json:"attributes"`
	} `json:"token"`
	Metadata struct {
		Name       string  `json:"name"`
		Title      string  `json:"title"`
		Attributes []trait `json:"attributes"`
	} `json:"metadata"`
	Name       string  `json:"name"`
	Title      string  `json:"title"`
	Attributes []trait `json:"attributes"`
}

type trait struct {
	TraitType string `json:"trait_type"`
	TraitName string `json:"traitType"`
	Type      string `json:"type"`
	Name      string `json:"name"`
	Value     any    `json:"value"`
}

type tokenMetadataPayload struct {
	Name       string  `json:"name"`
	Image      string  `json:"image"`
	Attributes []trait `json:"attributes"`
}

type howRareCollectionResponse struct {
	Result struct {
		Collection struct {
			Supply int `json:"supply"`
		} `json:"collection"`
		Data struct {
			Items []struct {
				Mint string `json:"mint"`
				Rank int    `json:"rank"`
			} `json:"items"`
		} `json:"data"`
	} `json:"result"`
}

type startupRow struct {
	Symbol           string
	Type             string
	ListedCount      *int
	ListedCountExact bool
	ImageURL         string
	SampledCount     int
	FilterMatches    int
	PriorityMatches  int
	MatchedTraits    []string
	Filters          []string
}

func main() {
	testPriorityEvent := flag.Bool("test-priority-event", false, "emit a sample priority event and exit")
	flag.Parse()

	cfg, err := loadConfig()
	if err != nil {
		log.Fatalf("load config: %v", err)
	}

	if *testPriorityEvent {
		t := &tracker{
			cfg:              cfg,
			httpClient:       &http.Client{Timeout: 20 * time.Second},
			seenListingSet:   map[string]struct{}{},
			seenSalesSet:     map[string]struct{}{},
			collectionSupply: map[string]int{},
			howRareCache:     map[string]map[string]int{},
			tokenMetadata:    map[string]metadataCacheEntry{},
		}
		if err := t.emitTestPriorityEvent(); err != nil {
			log.Fatalf("test priority event: %v", err)
		}
		return
	}

	s, err := discordgo.New("Bot " + cfg.DiscordToken)
	if err != nil {
		log.Fatalf("create discord session: %v", err)
	}

	t := &tracker{
		cfg:              cfg,
		session:          s,
		httpClient:       &http.Client{Timeout: 20 * time.Second},
		seenListingSet:   map[string]struct{}{},
		seenSalesSet:     map[string]struct{}{},
		collectionSupply: map[string]int{},
		howRareCache:     map[string]map[string]int{},
		tokenMetadata:    map[string]metadataCacheEntry{},
		status: pollStatus{
			StartedAt:   time.Now(),
			DynamicTick: time.Duration(cfg.RoundRobinTickMS) * time.Millisecond,
		},
	}

	s.AddHandler(t.onReady)
	s.AddHandler(t.onInteraction)
	if err := s.Open(); err != nil {
		log.Fatalf("open discord session: %v", err)
	}
	defer s.Close()

	select {}
}

func (t *tracker) emitTestPriorityEvent() error {
	if err := t.cacheSupplies(); err != nil {
		log.Printf("[test] cache supplies: %v", err)
	}

	tracks, err := loadTracks()
	if err != nil {
		return err
	}

	ctx := context.Background()
	for symbol, cfg := range tracks.Collections {
		listings, _, _, err := t.fetchCurrentListingsSnapshot(ctx, symbol)
		if err != nil {
			log.Printf("[test] listings snapshot for %s: %v", symbol, err)
			continue
		}
		for _, activity := range listings {
			summary := t.activityFilterSummary(symbol, cfg, activity)
			if !summary.Matches {
				continue
			}
			return t.emitTestPriorityResult(symbol, "listing", cfg, activity, summary, true)
		}
		if len(listings) > 0 {
			return t.emitTestPriorityResult(symbol, "listing", cfg, listings[0], t.activityFilterSummary(symbol, cfg, listings[0]), false)
		}
	}

	for symbol, cfg := range tracks.SalesCollections {
		activities, err := t.fetchCollectionActivities(ctx, symbol, "buyNow", 30)
		if err != nil {
			log.Printf("[test] sales activity for %s: %v", symbol, err)
			continue
		}
		for _, activity := range activities {
			summary := t.activityFilterSummary(symbol, cfg, activity)
			if !summary.Matches {
				continue
			}
			return t.emitTestPriorityResult(symbol, "sale", cfg, activity, summary, true)
		}
		if len(activities) > 0 {
			return t.emitTestPriorityResult(symbol, "sale", cfg, activities[0], t.activityFilterSummary(symbol, cfg, activities[0]), false)
		}
	}

	return errors.New("no current NFT activity found in tracked collections")
}

func (t *tracker) emitTestPriorityResult(symbol, activityType string, cfg CollectionTrack, activity listingActivity, summary activitySummary, matchedFilters bool) error {
	rarityRank := t.getActivityRarityRank(symbol, activity)
	rarityTier := getRarityTier(rarityRank, t.getSupply(symbol))
	link := "https://magiceden.io/item-details/" + firstNonEmpty(activity.TokenMint, activity.Mint)
	subtitleParts := []string{symbol, activityType, priceLabelForEvent(activity)}
	if !matchedFilters {
		subtitleParts = append(subtitleParts, "live fallback")
	}
	bodyLines := []string{
		fmt.Sprintf("%s • %s • %s", symbol, activityType, priceLabelForEvent(activity)),
	}
	if rarityRank > 0 {
		bodyLines = append(bodyLines, fmt.Sprintf("Rarity: %d (%s)", rarityRank, rarityTier))
		subtitleParts = append(subtitleParts, fmt.Sprintf("#%d", rarityRank))
	}
	if len(summary.MatchedTraits) > 0 {
		bodyLines = append(bodyLines, "Matched: "+strings.Join(summary.MatchedTraits, ", "))
	}
	filters := describeFilters(cfg)
	if len(filters) > 0 {
		bodyLines = append(bodyLines, "Filters: "+strings.Join(filters, ", "))
		if !matchedFilters {
			bodyLines = append(bodyLines, "Filter Status: no current live item matched filters, showing latest real NFT instead")
		}
	}
	bodyLines = append(bodyLines, "Link: "+link)

	emitUIEvent("priority_match", t.uiEventPayload(symbol, activityType, activity, strings.Join(bodyLines, "\n"), summary.MatchedTraits, rarityRank, rarityTier, strings.Join(subtitleParts, " · ")))
	return nil
}

func configPath() string {
	if v := strings.TrimSpace(os.Getenv("METRACKER_CONFIG_PATH")); v != "" {
		return v
	}
	return defaultConfigPath
}

func tracksPath() string {
	if v := strings.TrimSpace(os.Getenv("METRACKER_TRACKS_PATH")); v != "" {
		return v
	}
	return defaultTracksPath
}

func loadConfig() (Config, error) {
	var cfg Config
	raw, err := os.ReadFile(configPath())
	if err != nil {
		return cfg, err
	}
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return cfg, err
	}
	if cfg.RoundRobinTickMS <= 0 {
		cfg.RoundRobinTickMS = 150000
	}
	if cfg.BackoffMS <= 0 {
		cfg.BackoffMS = 10000
	}
	if cfg.StartupListingsPageLimit <= 0 {
		cfg.StartupListingsPageLimit = defaultStartupPageSize
	}
	if cfg.StartupListingsMaxPages <= 0 {
		cfg.StartupListingsMaxPages = defaultStartupMaxPages
	}
	if cfg.TokenMetadataTTLMS <= 0 {
		cfg.TokenMetadataTTLMS = int(defaultTokenTTL / time.Millisecond)
	}
	if cfg.MaxSeenIDs <= 0 {
		cfg.MaxSeenIDs = defaultMaxSeenIDs
	}
	if cfg.TestMessageDeleteSeconds <= 0 {
		cfg.TestMessageDeleteSeconds = 5
	}
	return cfg, nil
}

func (t *tracker) onReady(s *discordgo.Session, _ *discordgo.Ready) {
	log.Printf("logged in as %s", s.State.User.String())
	if err := t.registerCommands(); err != nil {
		log.Printf("register commands: %v", err)
	}
	if err := t.cacheSupplies(); err != nil {
		log.Printf("cache supplies: %v", err)
	}
	if err := t.indexCurrentActivities(); err != nil {
		log.Printf("index current activities: %v", err)
	}
	if err := t.sendStartupSummary(context.Background()); err != nil {
		log.Printf("startup summary: %v", err)
	}
	go t.pollLoop()
}

func (t *tracker) registerCommands() error {
	commands := []*discordgo.ApplicationCommand{
		{
			Name:        "metrack",
			Description: "Track a collection. Traits format: Background=Blue; Eyes=Laser|Gold",
			Options: []*discordgo.ApplicationCommandOption{
				{Name: "symbol", Description: "Magic Eden URL or collection symbol", Type: discordgo.ApplicationCommandOptionString, Required: true},
				{Name: "max_price", Description: "Max price in SOL", Type: discordgo.ApplicationCommandOptionNumber, Required: true},
				{Name: "traits", Description: "Optional trait filters. Example: Background=Blue; Eyes=Laser|Gold", Type: discordgo.ApplicationCommandOptionString, Required: false},
			},
		},
		{
			Name:        "meuntrack",
			Description: "Stop tracking listings for a collection",
			Options: []*discordgo.ApplicationCommandOption{
				{Name: "symbol", Description: "Magic Eden URL or collection symbol", Type: discordgo.ApplicationCommandOptionString, Required: true},
			},
		},
		{
			Name:        "mesalestrack",
			Description: "Track sales for a collection. Traits format: Background=Blue; Eyes=Laser|Gold",
			Options: []*discordgo.ApplicationCommandOption{
				{Name: "symbol", Description: "Magic Eden URL or collection symbol", Type: discordgo.ApplicationCommandOptionString, Required: true},
				{Name: "max_price", Description: "Max price in SOL", Type: discordgo.ApplicationCommandOptionNumber, Required: true},
				{Name: "traits", Description: "Optional trait filters. Example: Background=Blue; Eyes=Laser|Gold", Type: discordgo.ApplicationCommandOptionString, Required: false},
			},
		},
		{
			Name:        "mesalesuntrack",
			Description: "Stop tracking sales for a collection",
			Options: []*discordgo.ApplicationCommandOption{
				{Name: "symbol", Description: "Magic Eden URL or collection symbol", Type: discordgo.ApplicationCommandOptionString, Required: true},
			},
		},
		{Name: "melist", Description: "List tracked collections"},
		{Name: "mestatus", Description: "Show tracker health and polling status"},
		{Name: "metest", Description: "Clear seen cache and re-alert on current listings/sales"},
		{Name: "mecleanup", Description: "Delete recent bot messages in the configured channel"},
	}

	for _, cmd := range commands {
		if _, err := t.session.ApplicationCommandCreate(t.cfg.ClientID, t.cfg.GuildID, cmd); err != nil {
			return err
		}
	}
	return nil
}

func (t *tracker) onInteraction(s *discordgo.Session, i *discordgo.InteractionCreate) {
	if i.Type != discordgo.InteractionApplicationCommand {
		return
	}
	if i.Member == nil || i.Member.User == nil || i.Member.User.ID != t.cfg.OwnerID {
		_ = s.InteractionRespond(i.Interaction, &discordgo.InteractionResponse{
			Type: discordgo.InteractionResponseChannelMessageWithSource,
			Data: &discordgo.InteractionResponseData{
				Content: "You're not my daddy.",
				Flags:   discordgo.MessageFlagsEphemeral,
			},
		})
		return
	}

	switch i.ApplicationCommandData().Name {
	case "metrack":
		t.handleTrack(i, false)
	case "meuntrack":
		t.handleUntrack(i, false)
	case "mesalestrack":
		t.handleTrack(i, true)
	case "mesalesuntrack":
		t.handleUntrack(i, true)
	case "melist":
		t.handleList(i)
	case "mestatus":
		t.handleStatus(i)
	case "metest":
		t.handleTest(i)
	case "mecleanup":
		t.handleCleanup(i)
	}
}

func (t *tracker) pollLoop() {
	for {
		t.mu.Lock()
		sleepFor := t.status.DynamicTick
		backoffUntil := t.status.BackoffUntil
		t.mu.Unlock()

		if !backoffUntil.IsZero() && time.Now().Before(backoffUntil) {
			time.Sleep(time.Until(backoffUntil))
			continue
		}

		time.Sleep(sleepFor)
		if err := t.pollNextTask(context.Background()); err != nil {
			log.Printf("poll: %v", err)
		}
	}
}

func (t *tracker) pollNextTask(ctx context.Context) error {
	tracks, err := loadTracks()
	if err != nil {
		return err
	}

	type task struct {
		Symbol string
		Type   string
		Config CollectionTrack
	}

	var tasks []task
	for symbol, cfg := range tracks.Collections {
		tasks = append(tasks, task{Symbol: symbol, Type: "listing", Config: cfg})
	}
	for symbol, cfg := range tracks.SalesCollections {
		tasks = append(tasks, task{Symbol: symbol, Type: "sales", Config: cfg})
	}
	if len(tasks) == 0 {
		return nil
	}

	t.mu.Lock()
	current := tasks[t.roundRobinIndex%len(tasks)]
	t.roundRobinIndex = (t.roundRobinIndex + 1) % len(tasks)
	t.status.LastPollAt = time.Now()
	t.status.LastTask = current.Type + ":" + current.Symbol
	t.mu.Unlock()

	log.Printf("[poll] checking %s for %s", current.Type, current.Symbol)

	var activities []listingActivity
	switch current.Type {
	case "listing":
		activities, err = t.fetchCollectionActivities(ctx, current.Symbol, "list", 100)
	case "sales":
		activities, err = t.fetchCollectionActivities(ctx, current.Symbol, "buyNow", 100)
	}
	if err != nil {
		var rateErr *rateLimitError
		if errors.As(err, &rateErr) {
			t.handleBackoff()
			return nil
		}
		t.recordError(err)
		return err
	}

	for _, activity := range activities {
		if err := t.processActivity(current.Symbol, current.Type, current.Config, activity); err != nil {
			log.Printf("process %s/%s: %v", current.Type, current.Symbol, err)
		}
	}

	t.mu.Lock()
	t.status.LastSuccess = time.Now()
	t.status.LastError = ""
	t.mu.Unlock()
	return nil
}

type rateLimitError struct{}

func (r *rateLimitError) Error() string { return "magic eden rate limited" }

func (t *tracker) handleBackoff() {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.status.BackoffUntil = time.Now().Add(time.Duration(t.cfg.BackoffMS) * time.Millisecond)
	t.status.LastBackoff = time.Now()
	next := t.status.DynamicTick + 30*time.Second
	maxTick := 10 * time.Minute
	if next > maxTick {
		next = maxTick
	}
	if next < time.Duration(t.cfg.RoundRobinTickMS)*time.Millisecond {
		next = time.Duration(t.cfg.RoundRobinTickMS) * time.Millisecond
	}
	t.status.DynamicTick = next
}

func (t *tracker) recordError(err error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.status.LastError = err.Error()
}

func (t *tracker) processActivity(symbol, activityType string, cfg CollectionTrack, activity listingActivity) error {
	id := getActivityID(activity, activityType, symbol)
	if t.seenHas(activityType, id) {
		return nil
	}

	priceNum, ok := numericValue(activity.Price)
	if !ok {
		priceNum, ok = numericValue(activity.PriceSol)
	}
	if !ok {
		priceNum, ok = numericValue(activity.BuyNowPrice)
	}
	if !ok {
		return nil
	}

	if cfg.MaxPrice != nil && priceNum > *cfg.MaxPrice {
		return nil
	}

	howRareRank := t.getActivityRarityRank(symbol, activity)
	rarityTier := getRarityTier(howRareRank, t.getSupply(symbol))
	if cfg.MinRarity != "" && rarityIndex(rarityTier) > rarityIndex(cfg.MinRarity) {
		t.seenAdd(activityType, id)
		return nil
	}

	t.hydrateActivityMetadata(context.Background(), &activity)
	traitMatch := matchTraitFilters(extractTraits(activity), cfg.Traits, cfg.TraitMatch)
	isPriority := len(cfg.Traits) > 0 && traitMatch.Matches

	notifyOn := strings.ToLower(strings.TrimSpace(cfg.NotifyOn))
	if notifyOn == "" {
		notifyOn = notifyOnAll
	}

	t.seenAdd(activityType, id)
	if notifyOn == notifyOnPriority && !isPriority {
		return nil
	}

	embed := buildAlertEmbed(symbol, activityType, cfg, activity, howRareRank, rarityTier, traitMatch, isPriority)
	repeats := 1
	if isPriority {
		repeats = traitAlertRepeats(cfg)
	}
	content := ""
	if isPriority {
		parts := []string{}
		if t.cfg.PriorityMentionOwner {
			parts = append(parts, "<@"+t.cfg.OwnerID+">")
		}
		parts = append(parts, "PRIORITY TRAIT MATCH")
		if len(traitMatch.MatchedTraits) > 0 {
			parts = append(parts, "Matched: "+strings.Join(traitMatch.MatchedTraits, ", "))
		}
		content = strings.Join(parts, " | ")
	}

	for i := 0; i < repeats; i++ {
		if _, err := t.session.ChannelMessageSendComplex(t.cfg.DiscordChannelID, &discordgo.MessageSend{
			Content: content,
			Embeds:  []*discordgo.MessageEmbed{embed},
			AllowedMentions: &discordgo.MessageAllowedMentions{
				Users: func() []string {
					if isPriority && t.cfg.PriorityMentionOwner {
						return []string{t.cfg.OwnerID}
					}
					return []string{}
				}(),
			},
		}); err != nil {
			return err
		}
	}
	if isPriority {
		body := fmt.Sprintf("%s • %s • %s", symbol, activityType, priceLabelForEvent(activity))
		if len(traitMatch.MatchedTraits) > 0 {
			body += "\nMatched: " + strings.Join(traitMatch.MatchedTraits, ", ")
		}
		rarityRank := t.getActivityRarityRank(symbol, activity)
		rarityTier := getRarityTier(rarityRank, t.getSupply(symbol))
		emitUIEvent("priority_match", t.uiEventPayload(symbol, activityType, activity, body, traitMatch.MatchedTraits, rarityRank, rarityTier, ""))
	}
	return nil
}

func (t *tracker) uiEventPayload(symbol, activityType string, activity listingActivity, body string, matchedTraits []string, rarityRank int, rarityTier, subtitle string) map[string]string {
	payload := map[string]string{
		"title":       activityName(activity),
		"subtitle":    subtitle,
		"body":        body,
		"symbol":      symbol,
		"activity":    activityType,
		"nft_name":    activityName(activity),
		"price":       priceLabelForEvent(activity),
		"mint":        firstNonEmpty(activity.TokenMint, activity.Mint),
		"link":        "https://magiceden.io/item-details/" + firstNonEmpty(activity.TokenMint, activity.Mint),
		"image_url":   activityImage(activity),
		"traits":      strings.Join(matchedTraits, ", "),
		"rarity":      "",
		"rarity_tier": "",
	}
	if rarityRank > 0 {
		payload["rarity"] = strconv.Itoa(rarityRank)
		payload["rarity_tier"] = rarityTier
	}
	if strings.TrimSpace(payload["subtitle"]) == "" {
		parts := []string{symbol, activityType, payload["price"]}
		if rarityRank > 0 {
			parts = append(parts, "#"+strconv.Itoa(rarityRank))
		}
		payload["subtitle"] = strings.Join(parts, " · ")
	}
	return payload
}

func (t *tracker) fetchCollectionActivities(ctx context.Context, symbol, eventType string, limit int) ([]listingActivity, error) {
	u := fmt.Sprintf("https://api-mainnet.magiceden.dev/v2/collections/%s/activities?limit=%d", url.QueryEscape(symbol), limit)
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	req.Header.Set("Accept", "application/json")
	res, err := t.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusTooManyRequests {
		return nil, &rateLimitError{}
	}
	if res.StatusCode >= 400 {
		body, _ := io.ReadAll(res.Body)
		return nil, fmt.Errorf("activities %s: %d %s", symbol, res.StatusCode, strings.TrimSpace(string(body)))
	}
	var data []listingActivity
	if err := json.NewDecoder(res.Body).Decode(&data); err != nil {
		return nil, err
	}
	filtered := make([]listingActivity, 0, len(data))
	for _, item := range data {
		if item.Type == eventType {
			filtered = append(filtered, item)
		}
	}
	return filtered, nil
}

func (t *tracker) fetchCurrentListingsSnapshot(ctx context.Context, symbol string) ([]listingActivity, *int, bool, error) {
	limit := minInt(maxInt(t.cfg.StartupListingsPageLimit, 1), 100)
	maxPages := maxInt(t.cfg.StartupListingsMaxPages, 1)
	var out []listingActivity
	exact := true
	for page := 0; page < maxPages; page++ {
		offset := page * limit
		u := fmt.Sprintf("https://api-mainnet.magiceden.dev/v2/collections/%s/listings?offset=%d&limit=%d", url.QueryEscape(symbol), offset, limit)
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
		req.Header.Set("Accept", "application/json")
		res, err := t.httpClient.Do(req)
		if err != nil {
			return out, ptrInt(len(out)), false, err
		}
		if res.StatusCode >= 400 {
			body, _ := io.ReadAll(res.Body)
			res.Body.Close()
			return out, ptrInt(len(out)), false, fmt.Errorf("listings %s: %d %s", symbol, res.StatusCode, strings.TrimSpace(string(body)))
		}
		var pageListings []listingActivity
		err = json.NewDecoder(res.Body).Decode(&pageListings)
		res.Body.Close()
		if err != nil {
			return out, ptrInt(len(out)), false, err
		}
		out = append(out, pageListings...)
		if len(pageListings) < limit {
			count := len(out)
			return out, &count, exact, nil
		}
	}
	exact = false
	count := len(out)
	return out, &count, exact, nil
}

func (t *tracker) fetchCollectionInfo(ctx context.Context, symbol string) (*magicEdenCollection, error) {
	u := fmt.Sprintf("https://api-mainnet.magiceden.dev/v2/collections/%s", url.QueryEscape(symbol))
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	req.Header.Set("Accept", "application/json")
	res, err := t.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode >= 400 {
		return nil, fmt.Errorf("collection %s: %d", symbol, res.StatusCode)
	}
	var data magicEdenCollection
	if err := json.NewDecoder(res.Body).Decode(&data); err != nil {
		return nil, err
	}
	return &data, nil
}

func (t *tracker) fetchTokenMetadata(ctx context.Context, mint string) (tokenMetadataPayload, error) {
	mint = strings.TrimSpace(mint)
	if mint == "" {
		return tokenMetadataPayload{}, errors.New("missing token mint")
	}

	ttl := time.Duration(t.cfg.TokenMetadataTTLMS) * time.Millisecond

	t.mu.Lock()
	if entry, ok := t.tokenMetadata[mint]; ok && time.Since(entry.CachedAt) < ttl {
		t.mu.Unlock()
		return entry.Data, nil
	}
	t.mu.Unlock()

	u := fmt.Sprintf("https://api-mainnet.magiceden.dev/v2/tokens/%s", url.PathEscape(mint))
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	req.Header.Set("Accept", "application/json")
	res, err := t.httpClient.Do(req)
	if err != nil {
		return tokenMetadataPayload{}, err
	}
	defer res.Body.Close()
	if res.StatusCode >= 400 {
		body, _ := io.ReadAll(res.Body)
		return tokenMetadataPayload{}, fmt.Errorf("token %s: %d %s", mint, res.StatusCode, strings.TrimSpace(string(body)))
	}

	var payload tokenMetadataPayload
	if err := json.NewDecoder(res.Body).Decode(&payload); err != nil {
		return tokenMetadataPayload{}, err
	}

	t.mu.Lock()
	t.tokenMetadata[mint] = metadataCacheEntry{
		CachedAt: time.Now(),
		Data:     payload,
	}
	t.mu.Unlock()

	return payload, nil
}

func (t *tracker) hydrateActivityMetadata(ctx context.Context, activity *listingActivity) {
	if activity == nil {
		return
	}
	if len(extractTraits(*activity)) > 0 && activityName(*activity) != "Unknown NFT" && activityImage(*activity) != "" {
		return
	}

	mint := firstNonEmpty(activity.TokenMint, activity.Mint)
	if mint == "" {
		return
	}

	payload, err := t.fetchTokenMetadata(ctx, mint)
	if err != nil {
		log.Printf("token metadata %s: %v", mint, err)
		return
	}

	if strings.TrimSpace(activity.Metadata.Name) == "" {
		activity.Metadata.Name = payload.Name
	}
	if strings.TrimSpace(activity.Token.Name) == "" {
		activity.Token.Name = payload.Name
	}
	if strings.TrimSpace(activity.Image) == "" {
		activity.Image = payload.Image
	}
	if strings.TrimSpace(activity.Token.Image) == "" {
		activity.Token.Image = payload.Image
	}
	if len(activity.Metadata.Attributes) == 0 {
		activity.Metadata.Attributes = payload.Attributes
	}
	if len(activity.Token.Attributes) == 0 {
		activity.Token.Attributes = payload.Attributes
	}
}

func (t *tracker) fetchHowRareCollection(ctx context.Context, symbol string) (map[string]int, int, error) {
	slug, ok := meToHowRare[symbol]
	if !ok {
		return nil, 0, nil
	}
	u := fmt.Sprintf("https://api.howrare.is/v0.1/collections/%s", url.QueryEscape(slug))
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	req.Header.Set("Accept", "application/json")
	res, err := t.httpClient.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer res.Body.Close()
	if res.StatusCode >= 400 {
		return nil, 0, fmt.Errorf("howrare %s: %d", symbol, res.StatusCode)
	}
	var payload howRareCollectionResponse
	if err := json.NewDecoder(res.Body).Decode(&payload); err != nil {
		return nil, 0, err
	}
	cache := map[string]int{}
	for _, item := range payload.Result.Data.Items {
		if item.Mint != "" && item.Rank > 0 {
			cache[item.Mint] = item.Rank
		}
	}
	return cache, payload.Result.Collection.Supply, nil
}

func (t *tracker) cacheSupplies() error {
	tracks, err := loadTracks()
	if err != nil {
		return err
	}
	symbolSet := map[string]struct{}{}
	for symbol := range tracks.Collections {
		symbolSet[symbol] = struct{}{}
	}
	for symbol := range tracks.SalesCollections {
		symbolSet[symbol] = struct{}{}
	}
	ctx := context.Background()
	for symbol := range symbolSet {
		cache, supply, err := t.fetchHowRareCollection(ctx, symbol)
		if err == nil && len(cache) > 0 {
			t.mu.Lock()
			t.howRareCache[symbol] = cache
			if supply > 0 {
				t.collectionSupply[symbol] = supply
			} else {
				t.collectionSupply[symbol] = len(cache)
			}
			t.mu.Unlock()
			continue
		}
		info, err := t.fetchCollectionInfo(ctx, symbol)
		if err == nil && info != nil && info.Stats.Supply != nil {
			t.mu.Lock()
			t.collectionSupply[symbol] = *info.Stats.Supply
			t.mu.Unlock()
			continue
		}
		if override := trackSupplyOverride(tracks, symbol); override != nil {
			t.mu.Lock()
			t.collectionSupply[symbol] = *override
			t.mu.Unlock()
		}
	}
	return nil
}

func (t *tracker) indexCurrentActivities() error {
	tracks, err := loadTracks()
	if err != nil {
		return err
	}
	ctx := context.Background()
	for symbol := range tracks.Collections {
		listings, err := t.fetchCollectionActivities(ctx, symbol, "list", 100)
		if err != nil {
			return err
		}
		log.Printf("[index] indexing %d listings for %s", len(listings), symbol)
		for _, item := range listings {
			t.seenAdd("listing", getActivityID(item, "listing", symbol))
		}
	}
	for symbol := range tracks.SalesCollections {
		sales, err := t.fetchCollectionActivities(ctx, symbol, "buyNow", 100)
		if err != nil {
			return err
		}
		log.Printf("[index] indexing %d sales for %s", len(sales), symbol)
		for _, item := range sales {
			t.seenAdd("sales", getActivityID(item, "sales", symbol))
		}
	}
	log.Printf("[index] indexed %d listings and %d sales at startup", len(t.seenListings), len(t.seenSales))
	return nil
}

func (t *tracker) sendStartupSummary(ctx context.Context) error {
	tracks, err := loadTracks()
	if err != nil {
		return err
	}

	var rows []startupRow
	for symbol, cfg := range tracks.Collections {
		info, _ := t.fetchCollectionInfo(ctx, symbol)
		currentListings, listedCount, exact, err := t.fetchCurrentListingsSnapshot(ctx, symbol)
		if err != nil {
			log.Printf("[startup] listings snapshot for %s: %v", symbol, err)
		}
		filterMatches := 0
		priorityMatches := 0
		matchedTraitSet := map[string]struct{}{}
		for _, item := range currentListings {
			summary := t.activityFilterSummary(symbol, cfg, item)
			if summary.Matches {
				filterMatches++
			}
			if summary.Priority {
				priorityMatches++
				for _, trait := range summary.MatchedTraits {
					matchedTraitSet[trait] = struct{}{}
				}
			}
		}
		row := startupRow{
			Symbol:           symbol,
			Type:             "listings",
			ListedCount:      listedCount,
			ListedCountExact: exact,
			ImageURL:         collectionImageURL(info, currentListings),
			SampledCount:     len(currentListings),
			FilterMatches:    filterMatches,
			PriorityMatches:  priorityMatches,
			MatchedTraits:    mapKeysSorted(matchedTraitSet),
			Filters:          describeFilters(cfg),
		}
		rows = append(rows, row)

		if row.PriorityMatches > 0 {
			if err := t.sendStartupPriorityAlert(ctx, symbol, cfg, currentListings); err != nil {
				log.Printf("[startup] priority alert for %s: %v", symbol, err)
			}
		}
	}
	for symbol := range tracks.SalesCollections {
		rows = append(rows, startupRow{
			Symbol:  symbol,
			Type:    "sales",
			Filters: []string{"sales tracking enabled"},
		})
	}
	slices.SortFunc(rows, func(a, b startupRow) int { return strings.Compare(a.Symbol, b.Symbol) })

	log.Printf("[startup] METRACKER v%s", version)
	log.Printf("[startup] tracking %d listing collection(s), %d sales collection(s)", len(tracks.Collections), len(tracks.SalesCollections))
	for _, row := range rows {
		listedLabel := "unknown"
		if row.ListedCount != nil {
			if row.ListedCountExact {
				listedLabel = strconv.Itoa(*row.ListedCount)
			} else {
				listedLabel = ">=" + strconv.Itoa(*row.ListedCount)
			}
		}
		log.Printf("[startup] %s (%s) listed=%s sampled=%d filterMatches=%d priorityMatches=%d filters=%s",
			row.Symbol, row.Type, listedLabel, row.SampledCount, row.FilterMatches, row.PriorityMatches, strings.Join(row.Filters, ", "))
	}

	header := &discordgo.MessageEmbed{
		Title:       "METRACKER STARTUP",
		Description: fmt.Sprintf("Tracking %d listing collection(s) and %d sales collection(s).", len(tracks.Collections), len(tracks.SalesCollections)),
		Color:       0x9b59ff,
		Footer:      &discordgo.MessageEmbedFooter{Text: fmt.Sprintf("Polling every %ds per task", int(t.status.DynamicTick.Seconds()))},
		Timestamp:   time.Now().Format(time.RFC3339),
	}

	embeds := []*discordgo.MessageEmbed{header}
	for _, row := range rows {
		listedLabel := "unknown"
		if row.ListedCount != nil {
			if row.ListedCountExact {
				listedLabel = strconv.Itoa(*row.ListedCount)
			} else {
				listedLabel = ">=" + strconv.Itoa(*row.ListedCount)
			}
		}
		embed := &discordgo.MessageEmbed{
			Title: fmt.Sprintf("%s - %s", row.Symbol, row.Type),
			Color: func() int {
				if row.PriorityMatches > 0 {
					return 0xffd700
				}
				return 0x9b59ff
			}(),
			Fields: []*discordgo.MessageEmbedField{
				{Name: "Listed", Value: listedLabel, Inline: true},
				{Name: "Current sampled", Value: strconv.Itoa(row.SampledCount), Inline: true},
				{Name: "Filter matches", Value: strconv.Itoa(row.FilterMatches), Inline: true},
				{Name: "Priority matches", Value: strconv.Itoa(row.PriorityMatches), Inline: true},
				{Name: "Filters", Value: truncate(strings.Join(row.Filters, ", "), 1024), Inline: false},
			},
		}
		if len(row.MatchedTraits) > 0 {
			embed.Fields = append(embed.Fields, &discordgo.MessageEmbedField{
				Name:   "Matched traits",
				Value:  truncate(strings.Join(row.MatchedTraits, "\n"), 1024),
				Inline: false,
			})
		}
		if row.ImageURL != "" {
			embed.Thumbnail = &discordgo.MessageEmbedThumbnail{URL: row.ImageURL}
		}
		embeds = append(embeds, embed)
	}

	for i := 0; i < len(embeds); i += 10 {
		end := minInt(i+10, len(embeds))
		if _, err := t.session.ChannelMessageSendEmbeds(t.cfg.DiscordChannelID, embeds[i:end]); err != nil {
			return err
		}
	}
	return nil
}

func (t *tracker) sendStartupPriorityAlert(ctx context.Context, symbol string, cfg CollectionTrack, listings []listingActivity) error {
	for _, activity := range listings {
		summary := t.activityFilterSummary(symbol, cfg, activity)
		if !summary.Priority {
			continue
		}

		howRareRank := t.getActivityRarityRank(symbol, activity)
		rarityTier := getRarityTier(howRareRank, t.getSupply(symbol))
		embed := buildAlertEmbed(symbol, "listing", cfg, activity, howRareRank, rarityTier, traitMatch{
			Matches:       true,
			MatchedTraits: summary.MatchedTraits,
		}, true)
		embed.Footer = &discordgo.MessageEmbedFooter{
			Text: "Priority match found at startup",
		}

		contentParts := []string{"STARTUP PRIORITY MATCH"}
		if len(summary.MatchedTraits) > 0 {
			contentParts = append(contentParts, "Matched: "+strings.Join(summary.MatchedTraits, ", "))
		}

		_, err := t.session.ChannelMessageSendComplex(t.cfg.DiscordChannelID, &discordgo.MessageSend{
			Content: strings.Join(contentParts, " | "),
			Embeds:  []*discordgo.MessageEmbed{embed},
		})
		return err
	}
	return nil
}

type activitySummary struct {
	Matches       bool
	Priority      bool
	MatchedTraits []string
}

func (t *tracker) activityFilterSummary(symbol string, cfg CollectionTrack, activity listingActivity) activitySummary {
	priceNum, ok := numericValue(activity.Price)
	if !ok {
		priceNum, ok = numericValue(activity.PriceSol)
	}
	if !ok {
		priceNum, ok = numericValue(activity.BuyNowPrice)
	}
	if !ok {
		return activitySummary{}
	}
	if cfg.MaxPrice != nil && priceNum > *cfg.MaxPrice {
		return activitySummary{}
	}
	howRareRank := t.getActivityRarityRank(symbol, activity)
	rarityTier := getRarityTier(howRareRank, t.getSupply(symbol))
	if cfg.MinRarity != "" && rarityIndex(rarityTier) > rarityIndex(cfg.MinRarity) {
		return activitySummary{}
	}
	t.hydrateActivityMetadata(context.Background(), &activity)
	traitMatch := matchTraitFilters(extractTraits(activity), cfg.Traits, cfg.TraitMatch)
	return activitySummary{
		Matches:       true,
		Priority:      len(cfg.Traits) > 0 && traitMatch.Matches,
		MatchedTraits: traitMatch.MatchedTraits,
	}
}

func (t *tracker) handleTrack(i *discordgo.InteractionCreate, sales bool) {
	data := i.ApplicationCommandData()
	symbol, ok := extractSymbol(optionString(data.Options, "symbol"))
	if !ok {
		t.respond(i, "Could not extract collection symbol from the provided URL or symbol.", true)
		return
	}
	maxPrice := optionNumber(data.Options, "max_price")
	traitsRaw := optionString(data.Options, "traits")
	traits, err := parseTraits(traitsRaw)
	if err != nil {
		t.respond(i, "Could not parse traits. Use `Background=Blue; Eyes=Laser|Gold`.", true)
		return
	}

	tracks, err := loadTracks()
	if err != nil {
		t.respond(i, fmt.Sprintf("Read tracks: %v", err), true)
		return
	}

	target := tracks.Collections
	kind := "listings"
	if sales {
		target = tracks.SalesCollections
		kind = "sales"
	}
	cfg := target[symbol]
	cfg.MaxPrice = ptrFloat(maxPrice)
	if traits != nil {
		cfg.Traits = traits
	}
	target[symbol] = cfg
	if err := saveTracks(tracks); err != nil {
		t.respond(i, fmt.Sprintf("Save tracks: %v", err), true)
		return
	}
	_ = t.indexCurrentActivities()
	t.respond(i, fmt.Sprintf("Now tracking %s for %s with max price %.4g SOL.", kind, symbol, maxPrice), false)
}

func (t *tracker) handleUntrack(i *discordgo.InteractionCreate, sales bool) {
	data := i.ApplicationCommandData()
	symbol, ok := extractSymbol(optionString(data.Options, "symbol"))
	if !ok {
		t.respond(i, "Could not extract collection symbol from the provided URL or symbol.", true)
		return
	}
	tracks, err := loadTracks()
	if err != nil {
		t.respond(i, fmt.Sprintf("Read tracks: %v", err), true)
		return
	}
	if sales {
		delete(tracks.SalesCollections, symbol)
	} else {
		delete(tracks.Collections, symbol)
	}
	if err := saveTracks(tracks); err != nil {
		t.respond(i, fmt.Sprintf("Save tracks: %v", err), true)
		return
	}
	t.respond(i, fmt.Sprintf("Stopped tracking %s.", symbol), false)
}

func (t *tracker) handleList(i *discordgo.InteractionCreate) {
	tracks, err := loadTracks()
	if err != nil {
		t.respond(i, fmt.Sprintf("Read tracks: %v", err), true)
		return
	}
	var lines []string
	if len(tracks.Collections) > 0 {
		lines = append(lines, "**Tracking Listings:**")
		symbols := mapKeysSortedFromMap(tracks.Collections)
		for _, symbol := range symbols {
			cfg := tracks.Collections[symbol]
			price := "none"
			if cfg.MaxPrice != nil {
				price = fmt.Sprintf("%.4g SOL", *cfg.MaxPrice)
			}
			lines = append(lines, fmt.Sprintf("- %s: max price %s", symbol, price))
		}
	}
	if len(tracks.SalesCollections) > 0 {
		lines = append(lines, "**Tracking Sales:**")
		symbols := mapKeysSortedFromMap(tracks.SalesCollections)
		for _, symbol := range symbols {
			cfg := tracks.SalesCollections[symbol]
			price := "none"
			if cfg.MaxPrice != nil {
				price = fmt.Sprintf("%.4g SOL", *cfg.MaxPrice)
			}
			lines = append(lines, fmt.Sprintf("- %s: max price %s", symbol, price))
		}
	}
	if len(lines) == 0 {
		t.respond(i, "No collections are being tracked.", false)
		return
	}
	t.respond(i, strings.Join(lines, "\n"), false)
}

func (t *tracker) handleStatus(i *discordgo.InteractionCreate) {
	tracks, _ := loadTracks()
	t.mu.Lock()
	defer t.mu.Unlock()
	lines := []string{
		"Version: " + version,
		fmt.Sprintf("Tracked tasks: %d listings, %d sales", len(tracks.Collections), len(tracks.SalesCollections)),
		fmt.Sprintf("Tick: %ds per task", int(t.status.DynamicTick.Seconds())),
	}
	if !t.status.BackoffUntil.IsZero() && time.Now().Before(t.status.BackoffUntil) {
		lines = append(lines, fmt.Sprintf("Backoff: %ds remaining", int(time.Until(t.status.BackoffUntil).Seconds())))
	} else {
		lines = append(lines, "Backoff: none")
	}
	if !t.status.LastPollAt.IsZero() {
		lines = append(lines, "Last poll: "+t.status.LastPollAt.Format(time.RFC3339))
	}
	if !t.status.LastSuccess.IsZero() {
		lines = append(lines, "Last success: "+t.status.LastSuccess.Format(time.RFC3339))
	}
	if t.status.LastTask != "" {
		lines = append(lines, "Last task: "+t.status.LastTask)
	}
	if t.status.LastError != "" {
		lines = append(lines, "Last error: "+t.status.LastError)
	}
	lines = append(lines, fmt.Sprintf("Seen cache: %d listings, %d sales", len(t.seenListings), len(t.seenSales)))
	lines = append(lines, fmt.Sprintf("Token metadata cache: %d", len(t.tokenMetadata)))
	t.respond(i, strings.Join(lines, "\n"), true)
}

func (t *tracker) handleTest(i *discordgo.InteractionCreate) {
	t.mu.Lock()
	listings := len(t.seenListings)
	sales := len(t.seenSales)
	t.seenListings = nil
	t.seenListingSet = map[string]struct{}{}
	t.seenSales = nil
	t.seenSalesSet = map[string]struct{}{}
	t.mu.Unlock()
	t.respond(i, fmt.Sprintf("Cleared seen cache: %d listings, %d sales.", listings, sales), true)
}

func (t *tracker) handleCleanup(i *discordgo.InteractionCreate) {
	channelID := t.cfg.DiscordChannelID
	var beforeID string
	deleted := 0
	for {
		msgs, err := t.session.ChannelMessages(channelID, 100, beforeID, "", "")
		if err != nil {
			t.respond(i, "Cleanup failed: "+err.Error(), true)
			return
		}
		if len(msgs) == 0 {
			break
		}
		var toDelete []string
		for _, msg := range msgs {
			if msg.Author != nil && msg.Author.ID == t.session.State.User.ID {
				toDelete = append(toDelete, msg.ID)
			}
		}
		for _, id := range toDelete {
			_ = t.session.ChannelMessageDelete(channelID, id)
			deleted++
		}
		beforeID = msgs[len(msgs)-1].ID
		if len(msgs) < 100 {
			break
		}
	}
	t.respond(i, fmt.Sprintf("Deleted %d bot messages in the configured channel.", deleted), true)
}

func (t *tracker) respond(i *discordgo.InteractionCreate, content string, ephemeral bool) {
	flags := discordgo.MessageFlags(0)
	if ephemeral {
		flags = discordgo.MessageFlagsEphemeral
	}
	_ = t.session.InteractionRespond(i.Interaction, &discordgo.InteractionResponse{
		Type: discordgo.InteractionResponseChannelMessageWithSource,
		Data: &discordgo.InteractionResponseData{
			Content: content,
			Flags:   flags,
		},
	})
}

func loadTracks() (Tracks, error) {
	var tracks Tracks
	raw, err := os.ReadFile(tracksPath())
	if err != nil {
		return Tracks{Collections: map[string]CollectionTrack{}, SalesCollections: map[string]CollectionTrack{}}, nil
	}
	if err := json.Unmarshal(raw, &tracks); err != nil {
		return tracks, err
	}
	if tracks.Collections == nil {
		tracks.Collections = map[string]CollectionTrack{}
	}
	if tracks.SalesCollections == nil {
		tracks.SalesCollections = map[string]CollectionTrack{}
	}
	return tracks, nil
}

func saveTracks(tracks Tracks) error {
	if tracks.Collections == nil {
		tracks.Collections = map[string]CollectionTrack{}
	}
	if tracks.SalesCollections == nil {
		tracks.SalesCollections = map[string]CollectionTrack{}
	}
	data, err := json.MarshalIndent(tracks, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	path := tracksPath()
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	tmp := filepath.Join(dir, fmt.Sprintf(".%s.%d.tmp", filepath.Base(path), time.Now().UnixNano()))
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func extractSymbol(input string) (string, bool) {
	input = strings.TrimSpace(input)
	if input == "" {
		return "", false
	}
	if matches := symbolPattern.FindStringSubmatch(input); len(matches) == 2 {
		return matches[1], true
	}
	if regexp.MustCompile(`^[\w\-]+$`).MatchString(input) {
		return input, true
	}
	return "", false
}

func parseTraits(raw string) (map[string][]string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, nil
	}
	out := map[string][]string{}
	pairs := strings.Split(raw, ";")
	for _, pair := range pairs {
		pair = strings.TrimSpace(pair)
		if pair == "" {
			continue
		}
		idx := strings.Index(pair, "=")
		if idx <= 0 || idx == len(pair)-1 {
			return nil, fmt.Errorf("invalid trait filter: %s", pair)
		}
		name := strings.TrimSpace(pair[:idx])
		values := strings.Split(pair[idx+1:], "|")
		for i := range values {
			values[i] = strings.TrimSpace(values[i])
		}
		values = filter(values, func(v string) bool { return v != "" })
		if name == "" || len(values) == 0 {
			return nil, fmt.Errorf("invalid trait filter: %s", pair)
		}
		out[name] = values
	}
	if len(out) == 0 {
		return nil, nil
	}
	return out, nil
}

type traitMatch struct {
	Matches       bool
	MatchedTraits []string
}

func matchTraitFilters(attributes []trait, filters map[string][]string, mode string) traitMatch {
	if len(filters) == 0 {
		return traitMatch{Matches: true}
	}
	attrMap := map[string][]string{}
	for _, attr := range attributes {
		name := normalizeTraitText(firstNonEmpty(attr.TraitType, attr.TraitName, attr.Type, attr.Name))
		value := normalizeTraitText(fmt.Sprint(attr.Value))
		if name == "" || value == "" {
			continue
		}
		attrMap[name] = append(attrMap[name], value)
	}
	var matched []string
	for traitType, allowed := range filters {
		actual := attrMap[normalizeTraitText(traitType)]
		found := ""
		for _, candidate := range allowed {
			if slices.Contains(actual, normalizeTraitText(candidate)) {
				found = candidate
				break
			}
		}
		if found == "" && strings.ToLower(mode) != "any" {
			return traitMatch{}
		}
		if found != "" {
			matched = append(matched, traitType+": "+found)
		}
	}
	if strings.ToLower(mode) == "any" {
		return traitMatch{Matches: len(matched) > 0, MatchedTraits: matched}
	}
	return traitMatch{Matches: true, MatchedTraits: matched}
}

func buildAlertEmbed(symbol, activityType string, cfg CollectionTrack, activity listingActivity, howRareRank int, rarityTier string, traitMatch traitMatch, priority bool) *discordgo.MessageEmbed {
	priceNum, _ := numericValue(activity.Price)
	if priceNum == 0 {
		priceNum, _ = numericValue(activity.PriceSol)
	}
	if priceNum == 0 {
		priceNum, _ = numericValue(activity.BuyNowPrice)
	}
	priceLabel := fmt.Sprintf("%.4g SOL", priceNum)
	if cfg.MaxPrice != nil {
		priceLabel = fmt.Sprintf("%.4g SOL (<= %.4g SOL)", priceNum, *cfg.MaxPrice)
	}
	title := fmt.Sprintf("New %s in %s!", activityType, symbol)
	if activityType == "listing" {
		title = fmt.Sprintf("New listing in %s!", symbol)
	} else if activityType == "sales" {
		title = fmt.Sprintf("New sale in %s!", symbol)
	}
	if priority {
		title = "[PRIORITY] " + title
	}
	link := "https://magiceden.io/item-details/" + firstNonEmpty(activity.TokenMint, activity.Mint)
	fields := []*discordgo.MessageEmbedField{
		{Name: "NFT", Value: truncate(activityName(activity), 1024), Inline: true},
		{Name: "Price", Value: priceLabel, Inline: true},
	}
	if len(traitMatch.MatchedTraits) > 0 {
		fields = append(fields, &discordgo.MessageEmbedField{
			Name: func() string {
				if priority {
					return "Priority Traits"
				}
				return "Traits"
			}(),
			Value:  truncate(strings.Join(traitMatch.MatchedTraits, "\n"), 1024),
			Inline: false,
		})
	}
	if howRareRank > 0 {
		fields = append(fields, &discordgo.MessageEmbedField{
			Name:   "Rarity",
			Value:  fmt.Sprintf("%d (%s)", howRareRank, rarityTier),
			Inline: true,
		})
	}
	fields = append(fields, &discordgo.MessageEmbedField{
		Name:   "Open",
		Value:  "[View on Magic Eden](" + link + ")",
		Inline: true,
	})
	embed := &discordgo.MessageEmbed{
		Title: title,
		Description: func() string {
			if priority {
				return "**This listing matched one of your watched traits.**"
			}
			return ""
		}(),
		URL:    link,
		Color:  rarityColor(rarityTier),
		Fields: fields,
		Footer: &discordgo.MessageEmbedFooter{
			Text: func() string {
				if priority {
					return "Priority match - repeated alert"
				}
				return "Magic Eden tracker"
			}(),
		},
		Timestamp: time.Now().Format(time.RFC3339),
	}
	if image := activityImage(activity); image != "" {
		embed.Image = &discordgo.MessageEmbedImage{URL: image}
	}
	return embed
}

func rarityColor(rarityTier string) int {
	switch strings.ToLower(strings.TrimSpace(rarityTier)) {
	case "mythic":
		return 0xff7a18
	case "legendary":
		return 0xffb700
	case "epic":
		return 0xa56eff
	case "rare":
		return 0x4c8bf5
	case "uncommon":
		return 0x2fbf71
	default:
		return 0x8e8e93
	}
}

func (t *tracker) seenHas(activityType, id string) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	switch activityType {
	case "listing":
		_, ok := t.seenListingSet[id]
		return ok
	default:
		_, ok := t.seenSalesSet[id]
		return ok
	}
}

func (t *tracker) seenAdd(activityType, id string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	switch activityType {
	case "listing":
		if _, ok := t.seenListingSet[id]; ok {
			return
		}
		t.seenListings = append(t.seenListings, id)
		t.seenListingSet[id] = struct{}{}
		for len(t.seenListings) > t.cfg.MaxSeenIDs {
			oldest := t.seenListings[0]
			t.seenListings = t.seenListings[1:]
			delete(t.seenListingSet, oldest)
		}
	default:
		if _, ok := t.seenSalesSet[id]; ok {
			return
		}
		t.seenSales = append(t.seenSales, id)
		t.seenSalesSet[id] = struct{}{}
		for len(t.seenSales) > t.cfg.MaxSeenIDs {
			oldest := t.seenSales[0]
			t.seenSales = t.seenSales[1:]
			delete(t.seenSalesSet, oldest)
		}
	}
}

func (t *tracker) getSupply(symbol string) int {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.collectionSupply[symbol]
}

func (t *tracker) getActivityRarityRank(symbol string, activity listingActivity) int {
	if rank, ok := numericValue(activity.Rarity.HowRare.Rank); ok {
		return int(rank)
	}
	if rank, ok := numericValue(activity.Rarity.MeInstant.Rank); ok {
		return int(rank)
	}
	if rank, ok := numericValue(activity.Rarity.Rank); ok {
		return int(rank)
	}
	if rank, ok := numericValue(activity.Extra.HowRareRank); ok {
		return int(rank)
	}
	tokenMint := firstNonEmpty(activity.TokenMint, activity.Mint)
	t.mu.Lock()
	defer t.mu.Unlock()
	if ranks, ok := t.howRareCache[symbol]; ok {
		return ranks[tokenMint]
	}
	return 0
}

func getActivityID(activity listingActivity, activityType, symbol string) string {
	price := stringifyNumber(firstAny(activity.Price, activity.PriceSol, activity.BuyNowPrice))
	eventID := firstNonEmpty(activity.ID, stringifyAny(activity.BlockTime))
	tokenMint := firstNonEmpty(activity.TokenMint, activity.Mint)
	return strings.Join(filter([]string{activityType, symbol, eventID, tokenMint, price}, func(s string) bool { return s != "" }), ":")
}

func activityName(activity listingActivity) string {
	return firstNonEmpty(activity.Name, activity.Title, activity.Token.Name, activity.Token.Title, activity.Metadata.Name, activity.Metadata.Title, "Unknown NFT")
}

func activityImage(activity listingActivity) string {
	return firstNonEmpty(activity.Extra.Img, activity.Token.Image, activity.Image, activity.Img)
}

func priceLabelForEvent(activity listingActivity) string {
	priceNum, ok := numericValue(activity.Price)
	if !ok {
		priceNum, ok = numericValue(activity.PriceSol)
	}
	if !ok {
		priceNum, ok = numericValue(activity.BuyNowPrice)
	}
	if !ok {
		return "unknown price"
	}
	return fmt.Sprintf("%.4g SOL", priceNum)
}

func extractTraits(activity listingActivity) []trait {
	if len(activity.Token.Attributes) > 0 {
		return activity.Token.Attributes
	}
	if len(activity.Metadata.Attributes) > 0 {
		return activity.Metadata.Attributes
	}
	if len(activity.Attributes) > 0 {
		return activity.Attributes
	}
	return activity.Extra.Attributes
}

func collectionImageURL(info *magicEdenCollection, listings []listingActivity) string {
	if info != nil && info.Image != "" {
		return info.Image
	}
	if len(listings) > 0 {
		return activityImage(listings[0])
	}
	return ""
}

func describeFilters(cfg CollectionTrack) []string {
	out := []string{}
	if cfg.MaxPrice != nil {
		out = append(out, fmt.Sprintf("max %.4g SOL", *cfg.MaxPrice))
	} else {
		out = append(out, "no max")
	}
	if cfg.MinRarity != "" {
		out = append(out, "min "+cfg.MinRarity)
	}
	if len(cfg.Traits) > 0 {
		out = append(out, strings.ToLower(firstNonEmpty(cfg.TraitMatch, "all"))+" traits "+formatTraits(cfg.Traits))
	}
	return out
}

func formatTraits(traits map[string][]string) string {
	if len(traits) == 0 {
		return ""
	}
	keys := mapKeysSortedFromMap(traits)
	parts := make([]string, 0, len(keys))
	for _, key := range keys {
		parts = append(parts, key+"="+strings.Join(traits[key], "|"))
	}
	return strings.Join(parts, "; ")
}

func getRarityTier(rank, supply int) string {
	if rank <= 0 || supply <= 0 {
		return "Common"
	}
	p := float64(rank) / float64(supply)
	switch {
	case p <= 0.01:
		return "Mythic"
	case p <= 0.05:
		return "Legendary"
	case p <= 0.15:
		return "Epic"
	case p <= 0.35:
		return "Rare"
	case p <= 0.7:
		return "Uncommon"
	default:
		return "Common"
	}
}

func rarityIndex(name string) int {
	for i, item := range rarityOrder {
		if strings.EqualFold(item, name) {
			return i
		}
	}
	return len(rarityOrder)
}

func traitAlertRepeats(cfg CollectionTrack) int {
	if cfg.TraitAlertRepeats < 1 {
		return 1
	}
	if cfg.TraitAlertRepeats > maxPriorityRepeats {
		return maxPriorityRepeats
	}
	return cfg.TraitAlertRepeats
}

func trackSupplyOverride(tracks Tracks, symbol string) *int {
	if cfg, ok := tracks.Collections[symbol]; ok && cfg.SupplyOverride != nil {
		return cfg.SupplyOverride
	}
	if cfg, ok := tracks.SalesCollections[symbol]; ok && cfg.SupplyOverride != nil {
		return cfg.SupplyOverride
	}
	return nil
}

func optionString(options []*discordgo.ApplicationCommandInteractionDataOption, name string) string {
	for _, opt := range options {
		if opt.Name == name {
			return opt.StringValue()
		}
	}
	return ""
}

func optionNumber(options []*discordgo.ApplicationCommandInteractionDataOption, name string) float64 {
	for _, opt := range options {
		if opt.Name == name {
			return opt.FloatValue()
		}
	}
	return 0
}

func numericValue(v any) (float64, bool) {
	switch x := v.(type) {
	case float64:
		return x, true
	case float32:
		return float64(x), true
	case int:
		return float64(x), true
	case int64:
		return float64(x), true
	case json.Number:
		f, err := x.Float64()
		return f, err == nil
	case string:
		f, err := strconv.ParseFloat(strings.TrimSpace(x), 64)
		return f, err == nil
	default:
		return 0, false
	}
}

func stringifyNumber(v any) string {
	if n, ok := numericValue(v); ok {
		return strconv.FormatFloat(n, 'f', -1, 64)
	}
	return ""
}

func stringifyAny(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64)
	case int:
		return strconv.Itoa(x)
	case int64:
		return strconv.FormatInt(x, 10)
	default:
		return ""
	}
}

func firstAny(values ...any) any {
	for _, v := range values {
		switch x := v.(type) {
		case nil:
		case string:
			if strings.TrimSpace(x) != "" {
				return x
			}
		default:
			return x
		}
	}
	return nil
}

func emitUIEvent(kind string, payload map[string]string) {
	if payload == nil {
		payload = map[string]string{}
	}
	payload["kind"] = kind
	raw, err := json.Marshal(payload)
	if err != nil {
		log.Printf("ui event marshal: %v", err)
		return
	}
	fmt.Printf("%s%s\n", uiEventPrefix, raw)
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

func normalizeTraitText(v string) string {
	return strings.ToLower(strings.TrimSpace(v))
}

func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max]
}

func ptrFloat(v float64) *float64 { return &v }
func ptrInt(v int) *int           { return &v }

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func mapKeysSorted(m map[string]struct{}) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	slices.Sort(out)
	return out
}

func mapKeysSortedFromMap[T any](m map[string]T) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	slices.Sort(out)
	return out
}

func filter[T any](items []T, keep func(T) bool) []T {
	out := make([]T, 0, len(items))
	for _, item := range items {
		if keep(item) {
			out = append(out, item)
		}
	}
	return out
}
