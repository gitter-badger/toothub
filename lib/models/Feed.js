var util = require('util');
var _ = require('lodash');
var async = require('async');
var request = require('request');
var microformats = require('microformat-node');
var FeedParser = require('feedparser');
var stream = require('stream');

module.exports = function (models, baseClass) {
  var Feed = baseClass();
  Feed.collection = 'feeds';

  Feed.defaults = {
    url: '',
    name: null,
    author: null,
    disabled: false,
    statusCode: '',
    headers: {},
    lastError: '',
    encoding: 'utf8',
    maxAge: 3600000,
    timeout: 10000,
    lastDuration: 0,
    lastValidated: 0
  };

  Feed.id = function (obj) {
    return models.md5(obj.url);
  };

  // Poll all feeds with concurrent requests and rate-limited database fetch
  Feed.pollAll = function (options, each, done) {

    options = _.defaults(options || {}, {
      concurrency: 16
    });

    var unpause, exhausted;

    var queue = async.queue(function (feed, next) {
      feed.poll(options, function (err, r) {
        each(err, r);
        if (unpause) {
          unpause();
          unpause = null;
        }
        next(err, r);
      });
    }, options.concurrency);

    models.Feed.each(function (err, feed, next) {
      queue.push(feed);
      if (queue.tasks.length < options.concurrency) {
        next();
      } else {
        unpause = next;
      }
    }, function (err) {
      exhausted = true;
      if (queue.length === 0) { done(); }
    });

    queue.drain = function () {
      if (exhausted) { done(); }
    };

    return queue;
  };

  Feed.prototype.poll = function (options, next) {
    var $this = this;

    options = _.defaults(options || { }, {
      request: request
    });

    var t_now = Date.now();

    // Common exit point
    var _next = _.once(function (err, r) {
      setImmediate(function () {
        next(err, $this);
      });
      return $this;
    });

    // Bail out if this Feed is disabled.
    if ($this.disabled) { return _next(); }

    // Skip poll if stored content is newer than max_age.
    var age = t_now - $this.lastValidated;
    var max_age = ('max_age' in options) ? options.max_age : $this.maxAge;
    if (age < max_age) { return _next(); }

    // Request options
    var r_opts = {
      method: 'GET',
      url: $this.url,
      timeout: options.timeout || $this.timeout,
      encoding: null,
      jar: false,
      gzip: true,
      // TODO: Track 3xx redirects, update Feed URL on 301
      // followRedirect: false
    };

    // Conditional GET support...
    var prev_headers = $this.headers;
    if (prev_headers.etag) {
      r_opts.headers['If-None-Match'] = prev_headers.etag;
    }
    if (prev_headers['last-modified']) {
      r_opts.headers['If-Modified-Since'] = prev_headers['last-modified'];
    }

    var req = options.request(r_opts, function (err, resp, body) {
      $this.lastValidated = t_now;
      $this.lastDuration = Date.now() - t_now;
      if (err) {
        if ('ETIMEDOUT' == err.code || 'ESOCKETTIMEDOUT' == err.code) {
          $this.statusCode = 408;
          $this.lastError = err.code;
        } else {
          $this.statusCode = 499;
          $this.lastError = ''+err;
        }
      } else {
        $this.statusCode = resp.statusCode;
        $this.headers = resp.headers;
        if (body) {
          $this.body = body.toString($this.encoding);
        }
      }
      $this.parse(function (err, toots) {
        _next(err, $this);
      });
    });

    return $this;
  };

  Feed.prototype.parse = function (next) {
    var $this = this;
    if (this.statusCode >= 400) { return next(); }

    var saveNext = function (err, toots) {
      async.each(toots, function (toot, nextEach) {
        toot.save(nextEach);
      }, function (err) {
        $this.save(function (err, result) {
          next(err, toots);
        });
      });
    };

    // Figure out which parser to use, falling back to HTML.
    var type = this.headers['content-type'];
    if (type == 'application/rss+xml' || type == 'application/atom+xml') {
      this.parseXml(saveNext);
    } else {
      this.parseHtml(saveNext);
    }
  };

  function flattenProps (props) {
    var out = {};
    for (var k in props) {
      out[k] = props[k][0];
    }
    return out;
  }

  Feed.prototype.parseHtml = function (next) {
    var $this = this;
    var out = [];
    var options = {
      filters: ['h-feed']
    };
    microformats.parseHtml(this.body, options, function (err, data) {
      if (!data.items || !data.items.length) {
        return next(null, out);
      }
      data.items.forEach(function (hfeed) {

        var meta = flattenProps(hfeed.properties);
        $this.meta = {
          name: meta.name,
          author: meta.author
        };

        hfeed.children.forEach(function (hentry) {
          if ('h-entry' !== hentry.type[0]) { return; }

          var props = flattenProps(hentry.properties);
          out.push(new models.Toot({
            feedId: $this._id,
            url: props.url,
            published: new Date(props.published),
            author: props.author,
            content: props.content.html
          }));

        });

      });
      next(null, out);
    });
  };

  Feed.prototype.parseXml = function (next) {
    var $this = this;
    var out = [];

    var s = new stream.Readable();
    s._read = function noop() {};
    s.push($this.body);
    s.push(null);

    s.pipe(new FeedParser({
      addMeta: false
    })).on('error', function (error) {
      next(error, out);
    }).on('meta', function (meta) {
      $this.meta = {
        name: meta.title,
        author: meta.author
      };
    }).on('readable', function() {
      var item;
      while (item = this.read()) {
        out.push(new models.Toot({
          feedId: $this._id,
          url: item.link,
          published: item.date || item.pubdate,
          author: item.author,
          content: item.description || item.summary
        }));
      }
      next(null, out);
    });
  };

  return Feed;
};