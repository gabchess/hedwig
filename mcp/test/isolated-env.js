function isolatedServerEnvironment(env, mode = "consult") {
  const isolated = { ...env, HEDWIG_MODE: mode };
  delete isolated.OPENROUTER_API_KEY;
  delete isolated.HEDWIG_OPENROUTER_MODEL;
  return isolated;
}

module.exports = { isolatedServerEnvironment };
