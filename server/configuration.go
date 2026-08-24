package main

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

func (c *configuration) retentionSeconds() int64 {
	if c == nil || c.ReceiptRetentionDays <= 0 {
		return 30 * 86400
	}
	return int64(c.ReceiptRetentionDays) * 86400
}
