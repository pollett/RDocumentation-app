/**
 * PackageVersion.js
 *
 * @description :: TODO: You might write a short summary of how this model works and what it represents here.
 * @docs        :: http://sailsjs.org/documentation/concepts/models-and-orm/models
 */
var Promise = require('bluebird');
var _ = require('lodash');

module.exports = {

  attributes: {
    package_name: {
      type: Sequelize.STRING,
      allowNull: false
    },

    version: {
      type: Sequelize.STRING,
      allowNull: false
    },

    title: {
      type: Sequelize.TEXT
    },

    description: {
      type: Sequelize.TEXT,
      allowNull: false
    },

    release_date: {
      type: Sequelize.DATE,
      allowNull: true
    },

    license: {
      type: Sequelize.TEXT,
      allowNull: false
    },

    url: {
      type: Sequelize.TEXT,
    },

    copyright: {
      type: Sequelize.TEXT
    },

    readmemd: {
      type: Sequelize.TEXT,
      allowNull: true
    },

    sourceJSON: {
      type: Sequelize.TEXT,
      allowNull: true
    }


  },
  associations: function() {
    PackageVersion.belongsTo(Package,
      {
        as: 'package',
        foreignKey: {
          allowNull: false,
          name:'package_name',
          as: 'package'
        },
        onDelete: 'CASCADE'
      });

    PackageVersion.hasOne(Package, {as: 'package_latest', foreignKey : 'latest_version_id'});

    PackageVersion.belongsToMany(Package,
      { as: 'dependencies',
        through: Dependency,
        foreignKey: {
          name: 'dependant_version_id',
          as: 'dependencies'
        }
      });
    PackageVersion.belongsTo(Collaborator,
      {
        as: 'maintainer',
        foreignKey: {
          allowNull: true,
          name: 'maintainer_id',
          as: 'maintainer'
        }
      });
    PackageVersion.belongsToMany(Collaborator, {as: 'collaborators', through: 'Collaborations', foreignKey: 'authored_version_id', timestamps: false});

    PackageVersion.hasMany(Topic, {as: 'topics', foreignKey: 'package_version_id'});

    PackageVersion.hasMany(Review, {
      as: 'reviews',
      foreignKey: 'reviewable_id',
      constraints: false,
      scope: {
        reviewable: 'version'
      }
    });
  },

  options: {
    indexes: [
      {
        type: 'UNIQUE',
        fields: ['package_name', 'version']
      }
    ],

    getterMethods: {
      uri: function()  {
        return sails.getUrlFor({ target: 'PackageVersion.findByNameVersion' })
          .replace(':name', encodeURIComponent(this.getDataValue('package_name')))
          .replace(':version', encodeURIComponent(this.getDataValue('version')))
          .replace('/api/', '/');
      },
      api_uri: function()  {
        return sails.getUrlFor({ target: 'PackageVersion.findByNameVersion' })
          .replace(':name', encodeURIComponent(this.getDataValue('package_name')))
          .replace(':version', encodeURIComponent(this.getDataValue('version')));
      },
      canonicalLink: function() {
        if(!this.package) return null;
        if(!this.package.latest_version) return null;
        return sails.getUrlFor({ target: 'PackageVersion.findByNameVersion' })
          .replace(':name', encodeURIComponent(this.getDataValue('package_name')))
          .replace(':version', encodeURIComponent(this.package.latest_version.version))
          .replace('/api/', '/');
      }
    },

    classMethods: {

      getAllVersions: function(){
        return PackageVersion.findAll({ where:{ id:{ lte: 300  }}});
      },

      upsertPackageVersion: function(packageVersion, opts) {

        var options = _.defaults(_.clone(opts), { where: {name: packageVersion.package_name} });
        return Package.findOrCreate(options).spread(function(instance, created) {
          var options = _.defaults(_.clone(opts), {
            where: {
              package_name: packageVersion.package_name,
              version: packageVersion.version
            },
            defaults: packageVersion,
          });
          return PackageVersion.findOrCreate(options);
        });
      },

      createWithDescriptionFile: function(opts) {
        var description = opts.input;
        var type = description.repoType || 'cran';
        var readmemd = description.readme;
        var packageVersion = PackageService.mapDescriptionToPackageVersion(description);
        packageVersion.fields.sourceJSON = JSON.stringify(description);
        packageVersion.fields.readmemd = readmemd;
        packageVersion.fields.license = packageVersion.fields.license || "";

        return sequelize.transaction(function (t) {
          var package = Repository.findOrCreate({
            where: {name: type},
            transaction: t
          }).spread(function(repoInstance, created){
            return Package.upsert({
              name: packageVersion.package.name,
              type_id: repoInstance.id
            }, {
              transaction: t
            });
          });

          var maintainer = packageVersion.maintainer !== null ?
            Collaborator.insertAuthor(packageVersion.maintainer, {transaction: t}) : null;


          var authors = Promise.map(packageVersion.authors, function(author) {
            return Collaborator.insertAuthor(author, {transaction: t});
          });

          var dependencies = Package.bulkCreate(packageVersion.dependencies.map(function(dependency) {
            return {name: dependency.dependency_name};
          }), {
            transaction: t,
            fields: ['name'],
            ignoreDuplicates: true
          });


          return Promise.join(package, maintainer, authors, dependencies,
            function(packageInstance, maintainerInstance, authorInstances) {

              return PackageVersion.findOrInitialize(
                {
                  where: {
                    package_name: packageVersion.package.name,
                    version: packageVersion.fields.version
                  },
                  transaction: t
              }).spread(function(packageVersionInstance, initialized) {
                packageVersionInstance.set(packageVersion.fields);
                packageVersionInstance.setPackage(packageVersion.package.name, {save: false});
                if (maintainerInstance !== null) packageVersionInstance.setMaintainer(maintainerInstance, {save: false});
                return packageVersionInstance.save({transaction: t});
              }).then(function(packageVersionInstance) {
                var dependencies = packageVersion.dependencies.map(function(dependency) {
                  return _.merge(dependency, {dependant_version_id: packageVersionInstance.id});
                });

                var dep = Dependency.bulkCreate(dependencies, {
                  ignoreDuplicates: true,
                  transaction: t
                });
                var auth = packageVersionInstance.setCollaborators(authorInstances, {transaction: t, ignoreDuplicates: true});
                return Promise.join(dep, auth,
                  function(dependencies, authors) {
                    return PackageVersion.findAll({
                      where: {
                        package_name: packageVersion.package.name
                      },
                      order: [[sequelize.fn('ORDER_VERSION', sequelize.col('version')), 'DESC' ]],
                      transaction: t
                    }).then(function(versionInstances) {
                      return Package.update({
                          latest_version_id: versionInstances[0].id
                        },
                        {
                          where: { name: packageVersion.package.name },
                          transaction: t
                        }
                      ).then(function() {
                        return PackageVersion.update({
                          updated_at: null
                        }, {
                          where: {
                            id: { $in: versionInstances.map(function(v) {
                              return v.id;
                            })}
                          },
                          transaction: t
                        });
                      }).then(function(count) {
                        return packageVersionInstance;
                      });
                    });

                  });
              });

          });

        });
      }



    },

    underscored: true
  }


};

