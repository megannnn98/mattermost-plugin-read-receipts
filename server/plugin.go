package main

import (
	"net/http"
	"sync"

	"github.com/mattermost/mattermost/server/public/plugin"
	"github.com/mattermost/mattermost/server/public/pluginapi"
)

const (
	PluginID       = "com.integrasources.read-receipts"
	wsEventReceipt = "read_receipt"
	kvPrefixWM     = "wm_"
	kvPrefixRR     = "rr_"
	maxQueryIDs    = 200
	dwellMs        = 1000
)

type Plugin struct {
	plugin.MattermostPlugin

	client *pluginapi.Client

	configMu      sync.RWMutex
	configuration *configuration

	router *http.ServeMux
}

func (p *Plugin) OnActivate() error {
	p.client = pluginapi.NewClient(p.API, p.Driver)
	p.router = http.NewServeMux()
	p.registerRoutes()

	var cfg configuration
	if err := p.API.LoadPluginConfiguration(&cfg); err != nil {
		p.logWarn("load plugin configuration failed", "error", err.Error())
	}
	p.applyConfiguration(&cfg)

	return nil
}

func (p *Plugin) OnDeactivate() error {
	return nil
}

func (p *Plugin) OnConfigurationChange() error {
	var cfg configuration
	if err := p.API.LoadPluginConfiguration(&cfg); err != nil {
		return err
	}
	p.applyConfiguration(&cfg)
	return nil
}

func main() {
	plugin.ClientMain(&Plugin{})
}
