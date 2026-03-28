FROM crucible-runner:base

# Ruby 3.1+ from Debian repos + bundler
RUN apt-get update && apt-get install -y --no-install-recommends \
    ruby-full \
    ruby-dev \
    zlib1g-dev \
    libyaml-dev \
  && rm -rf /var/lib/apt/lists/* \
  && gem install bundler --no-document
