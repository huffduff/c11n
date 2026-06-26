package config

import (
	"time"

	"github.com/caarlos0/env/v11"
)

type Config struct {
	// Application
	AppEnv      string        `env:"APP_ENV" envDefault:"development"`
	Port        string        `env:"PORT" envDefault:"8080"`
	ReadTimeout time.Duration `env:"READ_TIMEOUT" envDefault:"5s"`
	
	// CORS
	AllowOrigin string `env:"ALLOW_ORIGIN" envDefault:"http://localhost:5173"`
	
	// WebSocket
	PingInterval time.Duration `env:"PING_INTERVAL" envDefault:"30s"`
	
	// Annotation Storage (future: could be database)
	StorageType string `env:"STORAGE_TYPE" envDefault:"memory"`
}

func Load() (*Config, error) {
	var cfg Config
	if err := env.Parse(&cfg); err != nil {
		return nil, err
	}
	return &cfg, nil
}