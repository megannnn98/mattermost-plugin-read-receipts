package main

const (
	defaultRetentionDays = 30
	minRetentionDays     = 1
	maxRetentionDays     = 3650
)

type configuration struct {
	EnableDebugLogging   bool `json:"EnableDebugLogging"`
	ReceiptRetentionDays int  `json:"ReceiptRetentionDays"`
}

func (c *configuration) Clone() *configuration {
	if c == nil {
		return &configuration{}
	}
	clone := *c
	return &clone
}

// retentionSeconds returns the per-post receipt TTL in seconds. Values that are
// missing or non-positive fall back to the default; anything else is clamped to
// [minRetentionDays, maxRetentionDays], so an overflow when converting days to
// seconds is structurally impossible.
func (c *configuration) retentionSeconds() int64 {
	days := c.retentionDays()
	return int64(days) * 86400
}

func (c *configuration) retentionDays() int {
	if c == nil || c.ReceiptRetentionDays <= 0 {
		return defaultRetentionDays
	}
	if c.ReceiptRetentionDays < minRetentionDays {
		return minRetentionDays
	}
	if c.ReceiptRetentionDays > maxRetentionDays {
		return maxRetentionDays
	}
	return c.ReceiptRetentionDays
}

// validate returns a clamped copy of the configuration plus a list of human
// readable warnings for every value that had to be corrected. Callers log the
// warnings during activation / re-configuration.
func (c *configuration) validate() (*configuration, []string) {
	if c == nil {
		return &configuration{
			EnableDebugLogging:   false,
			ReceiptRetentionDays: defaultRetentionDays,
		}, []string{"configuration is empty — using defaults"}
	}

	valid := c.Clone()
	var warnings []string

	if valid.ReceiptRetentionDays <= 0 {
		warnings = append(warnings, "ReceiptRetentionDays must be positive; using default")
		valid.ReceiptRetentionDays = defaultRetentionDays
	} else if valid.ReceiptRetentionDays < minRetentionDays {
		warnings = append(warnings, "ReceiptRetentionDays is too small; clamping to minimum")
		valid.ReceiptRetentionDays = minRetentionDays
	} else if valid.ReceiptRetentionDays > maxRetentionDays {
		warnings = append(warnings, "ReceiptRetentionDays is too large; clamping to maximum")
		valid.ReceiptRetentionDays = maxRetentionDays
	}

	return valid, warnings
}

// applyConfiguration validates the raw config, stores the clamped copy and logs
// a warning for every corrected value.
func (p *Plugin) applyConfiguration(cfg *configuration) {
	valid, warnings := cfg.validate()
	for _, w := range warnings {
		p.logWarn(w)
	}
	p.configMu.Lock()
	p.configuration = valid
	p.configMu.Unlock()
}
