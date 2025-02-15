const uuidv4 = require(`uuid/v4`);
const fs = require(`fs`);
const { buildSchema, printSchema } = require(`gatsby/graphql`);
const { transformSchema, introspectSchema, RenameTypes } = require(`graphql-tools`);
const { createHttpLink } = require(`apollo-link-http`);
const fetch = require(`node-fetch`);
const invariant = require(`invariant`);
const promiseRetry = require('promise-retry');

const { NamespaceUnderFieldTransform, StripNonQueryTransform } = require(`./transforms`);
const { getGQLOptions, defaultOptions } = require(`./builder-config`);

/**
 * @type { import('gatsby').GatsbyNode['sourceNodes'] }
 */
exports.sourceNodes = async ({ actions, createNodeId, cache, createContentDigest }, options) => {
  const { addThirdPartySchema, createNode } = actions;
  const config = getGQLOptions(options);
  const { url, typeName, fieldName } = config;

  const link = createHttpLink({
    uri: url,
    fetch,
    useGETForQueries: true,
  });

  const cacheKey = `@builder.io/gatsby-schema-${typeName}-${fieldName}`;
  let sdl = await cache.get(cacheKey);
  let introspectionSchema;

  if (!sdl) {
    introspectionSchema = await introspectSchema(link);
    sdl = printSchema(introspectionSchema);
  } else {
    introspectionSchema = buildSchema(sdl);
  }

  await cache.set(cacheKey, sdl);

  const nodeId = createNodeId(`@builder.io/gatsby-${typeName}`);
  const node = createSchemaNode({
    id: nodeId,
    typeName,
    fieldName,
    createContentDigest,
  });
  createNode(node);

  const resolver = (_, __, context) => {
    const { path, nodeModel } = context;
    nodeModel.createPageDependency({
      path,
      nodeId,
    });
    return {};
  };

  const schema = transformSchema(
    {
      schema: introspectionSchema,
      link,
    },
    [
      new StripNonQueryTransform(),
      new RenameTypes(name => `${typeName}_${name}`),
      new NamespaceUnderFieldTransform({
        typeName,
        fieldName,
        resolver,
      }),
    ]
  );

  addThirdPartySchema({ schema });
};

function createSchemaNode({ id, typeName, fieldName, createContentDigest }) {
  const contentDigest = createContentDigest(uuidv4());
  return {
    id,
    typeName,
    fieldName,
    parent: null,
    children: [],
    internal: {
      type: `BuilderPlugin`,
      contentDigest,
      ignoreType: true,
    },
  };
}

/**
 * @type { import('gatsby').GatsbyNode['createPages'] }
 */
exports.createPages = async ({ graphql, actions }, options) => {
  const config = {
    ...defaultOptions,
    ...options,
  };
  const { createPage } = actions;
  if (typeof config.templates === 'object') {
    const models = Object.keys(config.templates);
    const offsets = models.map(() => 0);
    await createPagesAsync(config, createPage, graphql, models, offsets);
  }
};

/**
 *
 * @typedef {{
 *  graphql: import('gatsby').CreatePagesArgs['graphql'],
 *  fieldName: any,
 *  models: any,
 *  offsets: any,
 *  limit: any
 * }} FetchPagesArgs
 *
 *
 * @param {FetchPagesArgs} param0
 */
const fetchPages = ({ fieldName, models, offsets, graphql, limit }) =>
  graphql(`
    query {
      ${fieldName} {
        ${models
          .map(
            (
              model,
              index
            ) => `${model}(limit: ${limit}, offset: ${offsets[index]}, options: { cacheSeconds: 2, staleCacheSeconds: 2 }) {
            content
          }`
          )
          .join(` `)}
      }
    }
  `);

const MAX_TRIES = 3;
/**
 *
 * @param {FetchPagesArgs} args
 */
const wrappedFetchPages = args =>
  promiseRetry(
    (retry, number) => {
      if (number > 1) {
        console.log(
          `[Builder.io] data-fetching for ${args.fieldName} failed. Retrying: ${number}/${MAX_TRIES}`
        );
      }

      return fetchPages(args).catch(retry);
    },
    { retries: MAX_TRIES }
  );

/**
 *
 * @param {*} config
 * @param {*} createPage
 * @param {import('gatsby').CreatePagesArgs['graphql']} graphql
 * @param {*} models
 * @param {*} offsets
 */
const createPagesAsync = async (config, createPage, graphql, models, offsets) => {
  const result = await wrappedFetchPages({
    fieldName: config.fieldName,
    models,
    offsets,
    graphql,
    limit: config.limit,
  });

  let hasMore = false;
  for (let index = 0; index < models.length; index++) {
    const modelName = models[index];

    const component = config.templates[modelName];
    invariant(
      fs.existsSync(component),
      `@builder.io/gatsby requires a valid template path for each model`
    );
    let entries = result.data[config.fieldName][modelName];
    offsets[index] = offsets[index] + entries.length;

    if (entries.length === config.limit) {
      hasMore = true;
    }

    if (config.filter) {
      entries = entries.filter(config.filter);
    }

    if (config.resolveDynamicEntries) {
      entries = await config.resolveDynamicEntries(entries);
    }

    for (const entry of entries) {
      if (entry.content.data.url && entry.content.published === `published`) {
        let mappedProps = {};

        if (config.mapEntryToContext) {
          mappedProps = await config.mapEntryToContext(entry, graphql);
        }

        createPage({
          path: entry.content.data.url,
          component,
          context: {
            ...(config.globalContext || {}),
            ...mappedProps,
          },
        });
      }
    }
  }
  if (hasMore) {
    await createPagesAsync(config, createPage, graphql, models, offsets);
  }
};

/**
 * @type { import('gatsby').GatsbyNode['onCreatePage'] }
 */
exports.onCreatePage = ({ page, actions }, options) => {
  const { deletePage, createPage } = actions;
  const config = {
    ...defaultOptions,
    ...options,
  };

  if (page.path === '/dev-404-page/' && config.overrideDev404) {
    const modelName = Object.keys(config.templates || {})[0];
    const context = {
      noStaticContent: true,
      ...page.context,
    };

    // override gatsby's custom 404 dev to allow development on Builder.io
    // with new pages without having to regenerate (restart gatsby develop)
    if (typeof config.custom404Dev === 'string') {
      deletePage(page);
      createPage({
        ...page,
        component: config.custom404Dev,
        context,
      });
    } else if (modelName) {
      deletePage(page);
      createPage({
        ...page,
        component: config.templates[modelName],
        context,
      });
    }
  }
};
