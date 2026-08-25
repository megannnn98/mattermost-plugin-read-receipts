package main

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestRetentionSeconds_Defaults(t *testing.T) {
	t.Run("nil config", func(t *testing.T) {
		var c *configuration
		assert.Equal(t, int64(defaultRetentionDays)*86400, c.retentionSeconds())
	})

	t.Run("zero -> default", func(t *testing.T) {
		c := &configuration{ReceiptRetentionDays: 0, EnabledChannelTypes: defaultChannelTypes}
		assert.Equal(t, int64(defaultRetentionDays)*86400, c.retentionSeconds())
	})

	t.Run("negative -> default", func(t *testing.T) {
		c := &configuration{ReceiptRetentionDays: -5, EnabledChannelTypes: defaultChannelTypes}
		assert.Equal(t, int64(defaultRetentionDays)*86400, c.retentionSeconds())
	})

	t.Run("in range unchanged", func(t *testing.T) {
		c := &configuration{ReceiptRetentionDays: 90}
		assert.Equal(t, int64(90)*86400, c.retentionSeconds())
	})
}

func TestValidate_Clamps(t *testing.T) {
	t.Run("nil -> defaults + warning", func(t *testing.T) {
		valid, warnings := (*configuration)(nil).validate()
		require.Len(t, warnings, 1)
		assert.Equal(t, defaultRetentionDays, valid.ReceiptRetentionDays)
	})

	t.Run("zero -> default + warning", func(t *testing.T) {
		valid, warnings := (&configuration{ReceiptRetentionDays: 0, EnabledChannelTypes: defaultChannelTypes}).validate()
		require.Len(t, warnings, 1)
		assert.Equal(t, defaultRetentionDays, valid.ReceiptRetentionDays)
	})

	t.Run("negative -> default + warning", func(t *testing.T) {
		valid, warnings := (&configuration{ReceiptRetentionDays: -100, EnabledChannelTypes: defaultChannelTypes}).validate()
		require.Len(t, warnings, 1)
		assert.Equal(t, defaultRetentionDays, valid.ReceiptRetentionDays)
	})

	t.Run("below min -> clamped to min", func(t *testing.T) {
		// can't be below min and still positive unless a caller passes something
		// like 0 which is handled above; a 1 is already min and passes.
		valid, warnings := (&configuration{ReceiptRetentionDays: 1, EnabledChannelTypes: defaultChannelTypes}).validate()
		assert.Len(t, warnings, 0)
		assert.Equal(t, minRetentionDays, valid.ReceiptRetentionDays)
	})

	t.Run("above max -> clamped to max", func(t *testing.T) {
		valid, warnings := (&configuration{ReceiptRetentionDays: 1_000_000_000, EnabledChannelTypes: defaultChannelTypes}).validate()
		require.Len(t, warnings, 1)
		assert.Equal(t, maxRetentionDays, valid.ReceiptRetentionDays)
		// days -> seconds must not overflow for the clamped value.
		assert.Equal(t, int64(maxRetentionDays)*86400, valid.retentionSeconds())
	})

	t.Run("exact max passes without warning", func(t *testing.T) {
		valid, warnings := (&configuration{ReceiptRetentionDays: maxRetentionDays, EnabledChannelTypes: defaultChannelTypes}).validate()
		assert.Len(t, warnings, 0)
		assert.Equal(t, maxRetentionDays, valid.ReceiptRetentionDays)
	})
}
