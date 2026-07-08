const { signAsync } = require('@electron/osx-sign');

module.exports = async function adHocMacSign(configuration) {
  await signAsync({
    ...configuration,
    identity: '-'
  });
};
