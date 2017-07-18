/**
 * LightController
 *
 * @description :: Server-side logic for rdocs-light
 * @help        :: See http://sailsjs.org/#!/documentation/concepts/Controllers
 */
var Promise = require('bluebird');

module.exports = {
  /**
  * @api {get} api/light/packages/:name/topics/:function Request Topic Information for Rdocs light
  * @apiName Get Topic in package (latest version which contains the topic)
  * @apiGroup Light
  *
  * @apiParam {String} Name of the package
  * @apiParam {String} Name of the topic
  *
  * @apiSuccess {String}   name                          Name of this topic
  * @apiSuccess {String}   title                         Title of the topic
  * @apiSuccess {String}   description                   Description of the topic
  * @apiSuccess {String}   url                           The Url to `self`
  * @apiSuccess {Object}   package_version               Informations about the version of the package
  * @apiSuccess {String}   package_version.url           Url to this version
  * @apiSuccess {String}   package_version.package_name  Name of the package of this version
  * @apiSuccess {String}   package_version.version       String describing the version of the package
  * @apiSuccess {Object[]} anchors                       Anchors shown at the bottom of the widget
  * @apiSuccess {String}   anchors.title                 The title to be shown
  * @apiSuccess {String}   anchors.anchor                The Html-anchor linking to the section
  */
  topicSearch: function(req,res) {
    var packageName = req.param('name'),
        topic_name = req.param('function');

    var key = 'light_' + packageName + '_' + topic_name;
    if (topic_name.endsWith('.html')) topic_name = topic_name.replace('.html', '');

    RedisService.getJSONFromCache(key, res, RedisService.DAILY, function() {
      return Topic.findAll({
        where: {name: topic_name},
        include: [{
          model: PackageVersion,
          as: 'package_version',
          where: { package_name: packageName },
          include: [
            { model: Package, as: 'package', attributes: ['name', 'latest_version_id', 'type_id' ]},
          ]
        },
        {model: Argument, as: 'arguments', attributes: ['name', 'description', 'topic_id'], separate:true },
        {model: Section, as: 'sections', attributes: ['name', 'description', 'topic_id'], separate:true },
        {model: Tag, as: 'keywords', attributes: ['name']},
        {model: Alias, as: 'aliases', attributes: ['name', 'topic_id'], separate: true },
        ]
      }).then(function(topicInstances) {
        if(topicInstances === null) {
          return Topic.findByAliasInPackage(packageName, topic).then(function(topicInstances) {
            if(!topicInstances) return null;
            else return topicInstances.sort(PackageService.compareVersions('desc', function(topic) {
            return topic.package_version.version }))[0];
          });
        }
        else return topicInstances.sort(PackageService.compareVersions('desc', function(topic) {
            return topic.package_version.version }))[0];
      }).then(function(topic){
        if(topic === undefined || topic === null) return null;
        return TopicService.processHrefs(topic, false);
      }).then(function(topic) {
        var part = {};
        if(topic !== null){
          part.name = topic.name;
          part.title = topic.title;
          part.description = topic.description;
          part.url = 'https:' + process.env.BASE_URL + topic.package_version.uri + '/topics/' + topic_name;
          part.package_version = {
            package_name: topic.package_version.package_name,
            version: topic.package_version.version,
            url: 'https:' + process.env.BASE_URL + topic.package_version.uri,
          };

          part.anchors = [];
          LightService.addAnchorItem(part.anchors, topic.keywords, "keywords", "kywrds");
          LightService.addAnchorItem(part.anchors, topic.usage, "usage", "usg");
          LightService.addAnchorItem(part.anchors, topic.arguments, "arguments", "argmnts");
          LightService.addAnchorItem(part.anchors, topic.details, "details", "dtls");
          LightService.addAnchorItem(part.anchors, topic.value, "value", "vl");
          LightService.addAnchorItem(part.anchors, topic.note, "note", "nt");
          LightService.addAnchorItem(part.anchors, topic.sections, "sections", "sctns");
          LightService.addAnchorItem(part.anchors, topic.references, "references", "rfrncs");
          LightService.addAnchorItem(part.anchors, topic.seealso, "see also", "sls");
          // LightService.addAnchorItem(part.anchors, topic.aliases, "aliases", "alss");
          LightService.addAnchorItem(part.anchors, topic.examples, "examples", "exmpls");

        }
        return part;
      });
    })
    .then(function(topic){
      return res.json(topic);
    })
    .catch(function(err) {
      return res.negotiate(err);
    });
  },

  /**
  * @api {get} api/light/packages/:name Request Package Information for Rdocs light
  * @apiName Get Package
  * @apiGroup Light
  *
  * @apiParam {String} name Name of the package
  *
  * @apiSuccess {String}   name             Package name
  * @apiSuccess {String}   url              Url to the package
  * @apiSuccess {Object}   version          Information about the version of the package
  * @apiSuccess {String}   version.version  String describing the latest version of the package
  * @apiSuccess {String}   version.url      Url to the version
  * @apiSuccess {String}   title            Title of the latest version
  * @apiSuccess {String}   description      Description of the latest package version
  * @apiSuccess {Object[]} anchors                       Anchors shown at the bottom of the widget
  * @apiSuccess {String}   anchors.title                 The title to be shown
  * @apiSuccess {String}   anchors.anchor                The Html-anchor linking to the section
  */
  packageSearch: function(req, res) {
    var packageName = req.param('name');

    var key = 'light_' + packageName;
    if (packageName.endsWith('.html')) packageName = packageName.replace('.html', '');

    RedisService.getJSONFromCache(key, res, RedisService.DAILY, function() {
      return Package.getLatestVersionNumber(packageName).then(function(version){
        console.log(version.latest_version.version);
        var prefix = "rpackages/unarchived/" + packageName + "/" + version.latest_version.version + "/" + "vignettes/";
        var params = {
          Bucket: process.env.AWS_BUCKET,
          Delimiter: '/',
          Prefix: prefix
        };

        var vignettesPromise = s3.listObjects(params).promise();

        var packagePromise = Package.findOne({
          include:[{
            model:PackageVersion,
            as:'latest_version',
            required:true,
            include: [
              { model: Topic, as: 'topics',
                attributes: ['package_version_id', 'name', 'title', 'id'],
                separate: true }
            ]
          }],
          where:{
            name:packageName
          }
        });
        return Promise.join(vignettesPromise, packagePromise, function(vignettes, package){
          var version = {};
          version.package_name = package.name;
          version.url = 'https:' + process.env.BASE_URL + package.uri;
          version.version = {
            version: package.latest_version.version,
            url: 'https:' + process.env.BASE_URL + package.latest_version.uri
          };
          version.title = package.latest_version.title;
          version.description = package.latest_version.description;

          version.anchors = [];
          LightService.addAnchorItem(version.anchors, package.latest_version.readmemd, "readme", "readme");
          LightService.addAnchorItem(version.anchors, package.latest_version.topics, "topics", "functions");
          LightService.addAnchorItem(version.anchors, vignettes.Contents, "vignettes", "vignettes");
          LightService.addAnchorItem(version.anchors, [true], "downloads", "downloads");
          LightService.addAnchorItem(version.anchors, [true], "details", "details");

          return version;
        });
      });
    })
    .then(function(version){
      return res.json(version);
    })
    .catch(function(err) {
      return res.negotiate(err);
    });

  }
}
