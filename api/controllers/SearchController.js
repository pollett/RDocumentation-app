/**
 * SearchController
 *
 * @description :: Server-side logic for searching
 * @help        :: See http://sailsjs.org/#!/documentation/concepts/Controllers
 */
var Promise = require('bluebird');
var _ = require('lodash');
var striptags = require('striptags');
var querystring = require('querystring');
var numeral = require('numeral');

module.exports = {

  quickSearch: function(req, res) {
    var token = req.body.token;

    es.msearch({
      body: [
        { index: 'rdoc', type: 'package_version' },
        { query: {
            bool: {
              should: [

                {
                  "has_parent" : {
                    "query" : {
                      "function_score" : {
                        "functions": [
                          {
                            "filter": { "missing" : { "field" : "part_of_r" } },
                            "field_value_factor": {
                              "field":    "last_month_downloads",
                              "modifier": "log1p"
                            }
                          },
                          {
                            "filter": { "term" : { "part_of_r" : 0 } },
                            "field_value_factor": {
                              "field":    "last_month_downloads",
                              "modifier": "log1p"
                            }
                          },
                          {
                            "filter": { "term" : { "part_of_r" : 1 } },
                            "field_value_factor": {
                              "field":    "part_of_r",
                              "modifier": "log1p",
                              "factor": 300000
                            }
                          }
                        ],
                        "boost_mode": "multiply"
                      }
                    },

                    "parent_type" : "package",
                    "score_mode" : "score"
                  }
                }
              ],
              "minimum_number_should_match": 2,
              filter: {
                bool: {
                  must: [
                    {
                      match_phrase_prefix : {
                        "package_name" : {
                            "query" : token,
                            "max_expansions" : 20,
                        }
                      }
                    },
                    {
                      term: { latest_version: 1 }
                    }
                  ]
                }

              }
            }
          },
          size: 5,
          fields: ['package_name', 'version']
        },

        { index: 'rdoc', type: 'topic' },
        { query: {

            bool: {
              should: [
                {
                  "multi_match" : {
                    "query":    token,
                    "fields": [ "aliases^2", "name" ]
                  }
                },
                {
                  "multi_match" : {
                    "fields" : ["aliases^2", "name"],
                    "query" : token,
                    "type" : "phrase_prefix"
                  }
                },
                {
                  has_parent : {
                    "parent_type" : "package_version",
                    "score_mode": "score",
                    query : {
                      "has_parent" : {
                        "query" : {
                          "function_score" : {
                            "functions": [
                              {
                                "filter": { "missing" : { "field" : "part_of_r" } },
                                "field_value_factor": {
                                  "field":    "last_month_downloads",
                                  "modifier": "log1p"
                                }
                              },
                              {
                                "filter": { "term" : { "part_of_r" : 0 } },
                                "field_value_factor": {
                                  "field":    "last_month_downloads",
                                  "modifier": "log1p"
                                }
                              },
                              {
                                "filter": { "term" : { "part_of_r" : 1 } },
                                "field_value_factor": {
                                  "field":    "part_of_r",
                                  "modifier": "log1p",
                                  "factor": 300000
                                }
                              }
                            ],
                            "boost_mode": "replace"
                          }
                        },

                        "parent_type" : "package",
                        "score_mode" : "score"
                      }
                    }
                  }
                }
              ],
              "minimum_number_should_match": 1,
              filter: {
                has_parent : {
                  parent_type : "package_version",
                  query : {
                    term : {
                        latest_version : 1
                    }
                  },
                  inner_hits : { fields: ['package_name', 'version', 'latest_version'] }
                }
              }
            }

          },
          size: 5,
          fields: ['name']
        },

    ]}).then(function(response) {
      var packageResult = response.responses[0];
      var topicResult = response.responses[1];
      var packages = _.map(packageResult.hits.hits, function(hit) {
        var name = hit.fields.package_name[0];
        var version = hit.fields.version[0];
        var uri = sails.getUrlFor({ target: 'PackageVersion.findByNameVersion' })
          .replace(':name', encodeURIComponent(name))
          .replace(':version', encodeURIComponent(version))
          .replace('/api/', '/');
        return { uri: uri,  name: name };
      });

      var topics = _.map(topicResult.hits.hits, function(hit) {
        var name = hit.fields.name[0];
        var id = hit._id;
        var inner_hit = hit.inner_hits.package_version.hits.hits[0];
        var package_name = inner_hit.fields.package_name[0];
        var version = inner_hit.fields.version[0];
        var uri = '/api/packages/:name/versions/:version/topics/:topic'
          .replace(':name', encodeURIComponent(package_name))
          .replace(':version', encodeURIComponent(version))
          .replace(':topic', encodeURIComponent(name))
          .replace('/api/', '/');
        return { uri: uri,  name: name, package_name: package_name, package_version: version };
      });
      return res.json({packages: packages, topics: topics});
    }).catch(function(err) {
      return res.negotiate(err);
    });

  },

  keywordSearch: function(req, res) {
    var keyword = req.param('keyword');
    var page = parseInt(req.param('page')) || 1;
    var perPage = parseInt(req.param('perPage')) || 10;
    var offset = (page - 1) * perPage;
    var nextPageQuery = _.clone(req.query);
    nextPageQuery.page = page + 1;

    var prevPageQuery = _.clone(req.query);
    prevPageQuery.page = page - 1;


    es.search({
      index: 'rdoc',
      body:{
        query: {
          bool: {
            filter: {
              type : {
                value : "topic"
              }
            },
            must: [
              {
                term: {
                  keywords:  keyword
                }
              },
              {
                has_parent : {
                  parent_type : "package_version",
                  query : {
                    term : {
                        latest_version : 1
                    }
                  },
                  inner_hits : { fields: ['package_name', 'version', 'latest_version'] }
                }
              }
            ]
          }
        },
        highlight : {
          pre_tags : ["<mark>"],
          post_tags : ["</mark>"],
          "fields" : {
            "keywords": {
              highlight_query: {
                term: {
                  keywords:  keyword
                }
              }
            },

          }
        },
        from: offset,
        size: perPage,
        fields: ['title', 'name', 'description', 'keywords']
      }

    }).then(function(response) {
      //return res.json(response);
      var hits = response.hits.hits.map(function(hit) {
        var fields = {};
        var highlight = hit.highlight;
        var inner_hits_fields = hit.inner_hits.package_version.hits.hits[0].fields;

        fields.package_name = inner_hits_fields.package_name[0];
        fields.version = inner_hits_fields.version[0];
        fields.name = hit.fields.name[0];

        highlight.title = hit.fields.title[0];
        highlight.description = hit.fields.description[0];

        return {
          fields: fields,
          type: hit._type,
          score: hit._score,
          highlight: hit.highlight
        };
      });
      return res.ok({
        total: numeral(response.hits.total).format('0,0'),
        hits: hits,
        perPage: perPage,
        currentPage: page,
        prevPageUrl: req.path + '?' + querystring.stringify(prevPageQuery),
        nextPageUrl: req.path + '?' + querystring.stringify(nextPageQuery),
        striptags: striptags,
        pageTitle: 'Search Results'
      }, 'search/result.ejs');
    });

  },

  packageSearch: function(query,offset,perPage){
    var searchTopicQuery = {
      multi_match: {
        query: query,
        type: "best_fields",
        boost: 0.7,
        fields: [
          'aliases^6',
          'name^2',
          'title^2', 'description', 'keywords^2',
          'arguments.name', 'arguments.description',
          'details', 'value',
          'note', 'author']
      }
    };
    return es.search({
      index: 'rdoc',
      body: {
        query: {
          bool : {
            should : [
              {
                bool: {
                  filter:[
                    {
                      type : {
                        value : "package_version"
                      }
                    },
                    { term: { latest_version: 1 } }
                  ],
                  should:[
                    {
                      multi_match: {
                        query: query,
                        type: "best_fields",
                        fields: ['package_name^6', 'title^4', 'maintainer.name^4', 'collaborators.name^3', 'description^3', 'license', 'url', 'copyright']
                      },
                    },
                    {
                      "has_parent" : {
                        "query" : {
                          "function_score" : {
                            "functions": [
                              {
                                "filter": { "missing" : { "field" : "part_of_r" } },
                                "field_value_factor": {
                                  "field":    "last_month_downloads",
                                  "modifier": "log1p"
                                }
                              },
                              {
                                "filter": { "term" : { "part_of_r" : 0 } },
                                "field_value_factor": {
                                  "field":    "last_month_downloads",
                                  "modifier": "log1p"
                                }
                              },
                              {
                                "filter": {  "term" : { "part_of_r" : 1 } },
                                "field_value_factor": {
                                  "field":    "part_of_r",
                                  "modifier": "log1p",
                                  "factor": 300000,
                                }
                              }
                            ],
                            "boost_mode": "replace"
                          }
                        },

                        "parent_type" : "package",
                        "score_mode" : "score"
                      }
                    }
                  ],
                  minimum_should_match : 1,
                }
              }],
            minimum_should_match : 1,
          }
        },
        highlight : {
          pre_tags : ["<mark>"],
          post_tags : ["</mark>"],
          "fields" : {
            "title" : {highlight_query: {
               match : {
                  title : query
              }
            }},
            "description": {highlight_query: {
               match : {
                  description : query
              }
            }},
            "collaborators.name": {highlight_query: {
               match : {
                  "collaborators.name" : query
              }
            }},
            "maintainer.name": {highlight_query: {
               match : {
                  "maintainer.name" : query
              }
            }},
            "name": {highlight_query: searchTopicQuery},
            "keywords": {highlight_query: searchTopicQuery},
            "aliases": {highlight_query: searchTopicQuery},
            "arguments.name": {highlight_query: searchTopicQuery},
            "arguments.description": {highlight_query: searchTopicQuery},
            "details": {highlight_query: searchTopicQuery},
            "value": {highlight_query: searchTopicQuery},
            "note": {highlight_query: searchTopicQuery},
            "author": {highlight_query: searchTopicQuery},
            "references": {highlight_query: searchTopicQuery},
            "license": {highlight_query: searchTopicQuery},
            "url": {highlight_query: searchTopicQuery},
            "copyright": {highlight_query: searchTopicQuery}
          }
        },
        from: offset,
        size: perPage,
        fields: ['package_name', 'version', 'name']
      }
    });
  },

  topicsSearch: function(query,offset,perPage){
    var searchTopicQuery = {
      multi_match: {
        query: query,
        type: "best_fields",
        boost: 0.7,
        fields: [
          'aliases^6',
          'name^2',
          'title^2', 'description', 'keywords^2',
          'arguments.name', 'arguments.description',
          'details', 'value',
          'note', 'author']
      }
    };
    return es.search({
      index: 'rdoc',
      body: {
        query: {
          bool : {
            should : [
              {
                bool: {
                  filter:[
                    {
                      type : {
                        value : "topic"
                      }
                    },
                    {
                      has_parent : {
                        parent_type : "package_version",
                        query : {  term : { latest_version : 1 } }
                      }
                    }
                  ],
                  should: [
                    searchTopicQuery,
                    {
                      has_parent : {
                        parent_type : "package_version",
                        score_mode: "score",

                        query : {
                          "has_parent" : {
                            "parent_type" : "package",
                            "score_mode" : "score",
                            "query" : {
                              "function_score" : {
                                "functions": [
                                  {
                                    "filter": { "missing" : { "field" : "part_of_r" } },
                                    "field_value_factor": {
                                      "field":    "last_month_downloads",
                                      "modifier": "log1p"
                                    }
                                  },
                                  {
                                    "filter": { "term" : { "part_of_r" : 0 } },
                                    "field_value_factor": {
                                      "field":    "last_month_downloads",
                                      "modifier": "log1p"
                                    }
                                  },
                                  {
                                    "filter": { "term" : { "part_of_r" : 1 } },
                                    "field_value_factor": {
                                      "field":    "part_of_r",
                                      "modifier": "log1p",
                                      "factor": 300000,
                                    }
                                  }
                                ],
                                "boost_mode": "replace"
                              }
                            }
                          }
                        },
                        inner_hits : { fields: ['package_name', 'version', 'latest_version'] }
                      }
                    }
                  ],
                  minimum_should_match : 1,
                }
              }],
            minimum_should_match : 1,
          }
        },
        highlight : {
          pre_tags : ["<mark>"],
          post_tags : ["</mark>"],
          "fields" : {
            "title" : {highlight_query: {
               match : {
                  title : query
              }
            }},
            "description": {highlight_query: {
               match : {
                  description : query
              }
            }},
            "collaborators.name": {highlight_query: {
               match : {
                  "collaborators.name" : query
              }
            }},
            "maintainer.name": {highlight_query: {
               match : {
                  "maintainer.name" : query
              }
            }},
            "name": {highlight_query: searchTopicQuery},
            "keywords": {highlight_query: searchTopicQuery},
            "aliases": {highlight_query: searchTopicQuery},
            "arguments.name": {highlight_query: searchTopicQuery},
            "arguments.description": {highlight_query: searchTopicQuery},
            "details": {highlight_query: searchTopicQuery},
            "value": {highlight_query: searchTopicQuery},
            "note": {highlight_query: searchTopicQuery},
            "author": {highlight_query: searchTopicQuery},
            "references": {highlight_query: searchTopicQuery},
            "license": {highlight_query: searchTopicQuery},
            "url": {highlight_query: searchTopicQuery},
            "copyright": {highlight_query: searchTopicQuery}
          }
        },
        from: offset,
        size: perPage,
        fields: ['package_name', 'version', 'name']
      }
    });
  },


  fullSearch: function(req, res) {
    var query = req.param('q');
    var ppage = parseInt(req.param('ppage')) || 1;
    var fpage = parseInt(req.param('fpage')) || 1;
    var perPage = parseInt(req.param('perPage')) || 10;
    var poffset = (ppage - 1) * perPage;
    var foffset = (fpage - 1) * perPage;
    var prevPPage = _.clone(req.query);
    prevPPage.ppage = ppage-1;
    var nextPPage = _.clone(req.query);
    nextPPage.ppage = ppage+1;
    var prevFPage = _.clone(req.query);
    prevFPage.fpage = fpage-1;
    var nextFPage = _.clone(req.query);
    nextFPage.fpage = fpage+1;
    
    return sails.controllers.search.packageSearch(query,poffset,perPage).then(function(response) {
       //return res.json(response);
      var topics = [];
      var packages  = [];
      response.hits.hits.forEach(function(hit) {
          var fields = {};
          fields.package_name = hit.fields.package_name[0];
          fields.version = hit.fields.version[0];
          packages.push({
            fields: fields,
            score: hit._score,
            highlight: hit.highlight
          });
        });
      return sails.controllers.search.topicsSearch(query,foffset,perPage).then(function(response){
        response.hits.hits.forEach(function(hit) {
        var fields = {};
        var inner_hits_fields = hit.inner_hits.package_version.hits.hits[0].fields;
          fields.package_name = inner_hits_fields.package_name[0];
          fields.version = inner_hits_fields.version[0];
          fields.name = hit.fields.name[0];
          topics.push({
            fields: fields,
            score: hit._score,
            highlight: hit.highlight
          });});
          return res.ok({
            total: numeral(response.hits.total).format('0,0'),
            packages: packages,
            topics: topics,
            perPage: perPage,
            params: req.query,
            prevPPage: req.path +'?'+ querystring.stringify(prevPPage),
            prevFPage: req.path +'?'+ querystring.stringify(prevFPage),
            nextPPage: req.path +'?'+ querystring.stringify(nextPPage),
            nextFPage: req.path +'?'+ querystring.stringify(nextFPage),
            ppage: ppage,
            fpage: fpage,
            striptags: striptags,
            pageTitle: 'Search Results'
          }, 'search/result.ejs');
        }).catch(function(err) {
          return res.negotiate(err);
        });
  });
  }

};
