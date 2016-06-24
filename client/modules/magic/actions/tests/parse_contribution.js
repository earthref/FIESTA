const {describe, it} = global;
import _ from 'lodash';
import {expect} from 'chai';
import Promise from 'bluebird';
import ParseContribution from '../parse_contribution';
import {default as contribution3552 } from './files/contributions/3552.js';
import {default as contribution8054 } from './files/contributions/8054.js';
import {default as contribution10507} from './files/contributions/10507.js';

describe('magic.actions.parse_contribution', () => {

  // Test parsing invalid strings.
  describe('when parsing invalid strings', () => {
    it('should warn about parsing an empty string', () => {
      return Promise.all([
        parseContributionWarningTest(undefined, /empty/i),
        parseContributionWarningTest('', /empty/i)
      ]);
    });

    it('should warn about parsing a non-string', () => {
      return Promise.all([
        parseContributionWarningTest(null, /not a string/i),
        parseContributionWarningTest({}, /not a string/i),
        parseContributionWarningTest(0, /not a string/i),
        parseContributionWarningTest(false, /not a string/i)
      ]);
    });

    it('should reject nonsense', () => {
      return parseContributionErrorTest('nonsense', /unrecognized column delimiter/i);
    });

    it('should reject nonsense with tab header', () => {
      return parseContributionErrorTest('nonsense\ttable', /unrecognized column delimiter/i);
    });

    it('should reject leading space nonsense', () => {
      return parseContributionErrorTest('  nonsense  \ttable\ncol1\tcol2\nstr1\t1.2', /. Expected "tab"./i);
    });

    it('should reject if table name is missing', () => {
      const noTableNames = [
        'tab\n',
        ' tab \n',
        ' tab \t',
        'tab\t\n',
        'tab\t \n'
      ];
      return Promise.all(noTableNames.map(noTableName =>
        parseContributionErrorTest(noTableName, /no table name following tab delimiter/i)
      ));
    });

    it('should reject repeated column names', () => {
      return parseContributionErrorTest('tab\ttable\ncol1\tcol1\n', /found duplicate column names/i);
    });

    it('should warn about empty tables', () => {
      return Promise.all([
        parseContributionWarningTest('tab\ttable\ncol1\tcol2\n', /no data values were found/i),
        parseContributionWarningTest('tab \t123\ncol1\tcol2\n', /no data values were found/i)
      ]);
    });
  });

  // Test getting version from invalid strings.
  describe('when getting version from invalid JSON', () => {
    it('should warn about getting version from an empty object', () => {
      getContributionVersionWarningTest(null, /the first argument .* is empty/i);
      getContributionVersionWarningTest(undefined, /the first argument .* is empty/i);
      getContributionVersionWarningTest({}, /the first argument .* is empty/i);
    });

    it('should reject when the "contribution" table does not have exactly one row.', () => {
      const jsonContribTwoRows = {
        contribution: [{
          magic_version: '2.2'
        }, {
          magic_version: '2.3'
        }]
      };
      getContributionVersionErrorTest(jsonContribTwoRows,
        /table does not have exactly one row./i);
    });

    it('should reject if the data model version is invalid.', () => {
      const invalidMagicVersion = {
        contribution: [{
          magic_version: '0.1'
        }]
      };
      getContributionVersionErrorTest(invalidMagicVersion,
        /data model version .* is invalid/i);
    });

  });

  // Test parsing valid strings.
  describe('when parsing valid strings', () => {
    it('should keep numbers as strings', () => {
      const json = {
        table: [{
          col1: 'str1',
          col2: '1.2'
        }]
      };
      return parseContributionJSONTest('tab\ttable\ncol1\tcol2\nstr1\t1.2', json);
    });

    it('should eliminate blank lines and leading/trailing spaces', () => {
      const withBlanks = [
        '\ntab\ttable\ncol1\tcol2\nstr1\t1.2',
        'tab delimited \ttable\ncol1\tcol2\n\n\nstr1\t1.2',
        ' tab\ttable\ncol1\tcol2\nstr1\t1.2',
        'tab any_non_tab_string\ttable\ncol1\tcol2\nstr1\t1.2',
        'tab any_non_tab_string\ttable\ncol1\tcol2\nstr1\t1.2',
        'tab\t  table\ncol1\tcol2\nstr1\t1.2',
        'tab\ttable\ncol1  \tcol2\n  str1\t1.2  '
      ];
      const json = {
        table: [{
          col1: 'str1',
          col2: '1.2'
        }]
      };
      return Promise.all(withBlanks.map(withBlank =>
        parseContributionJSONTest(withBlank, json)
      ));
    });

    it('should handle empty columns', () => {
      const withEmptyColumns = [
        'tab\ttable\nempty\tcol1\tcol2\n\tstr1\t1.2\n\tstr2\t1.0',
        'tab\ttable\ncol1\tempty\tcol2\nstr1\t\t1.2\nstr2\t\t1.0',
        'tab\ttable\ncol1\tcol2\tempty\nstr1\t1.2\t\nstr2\t1.0\t'
      ];
      const json = {
        table: [{
          col1: 'str1',
          col2: '1.2'
        }, {
          col1: 'str2',
          col2: '1.0'
        }]
      };
      return Promise.all(withEmptyColumns.map(withEmptyColumn =>
        parseContributionJSONTest(withEmptyColumn, json)
      ));
    });

    it('should combine rows', () => {
      const partial1 = 'tab\ttable\ncol1\tcol2\nstr1\t1.2';
      const partial2 = 'tab\ttable\ncol1\tcol2\nstr2\t1.0';
      const json = {
        table: [{
          col1: 'str1',
          col2: '1.2'
        }, {
          col1: 'str2',
          col2: '1.0'
        }]
      };
      return parseContributionsJSONTest([partial1, partial2], json);
    });

    it('should combine tables', () => {
      const partial1 = 'tab\ttable1\ncol1\tcol2\nstr1\t1.2';
      const partial2 = 'tab\ttable2\ncol1\tcol2\nstr2\t1.0';
      const json = {
        table1: [{
          col1: 'str1',
          col2: '1.2'
        }],
        table2: [{
          col1: 'str2',
          col2: '1.0'
        }]
      };
      return parseContributionsJSONTest([partial1, partial2], json);
    });
  });

  // Test parsing valid files.
  describe('when parsing valid files', () => {
    it('should parse contribution 3552 (MagIC version 2.2) with no errors', () => {
      return parseContributionNoErrorTest(contribution3552);
    });
    it('should parse contribution 8054 (MagIC version 2.4) with no errors', () => {
      return parseContributionNoErrorTest(contribution8054);
    });
    it('should parse contribution 10507 (MagIC version 2.5) with no errors', () => {
      return parseContributionNoErrorTest(contribution10507);
    });
  });
});

// Expect the warnings to contain one warning that matches the reWarningMsg regex.
const parseContributionWarningTest = (text, reWarningMsg, done) => {
  const parser = new ParseContribution({});
  return parser.parsePromise({text: text}).then(function() {
    expect(parser.warnings().length).to.be.at.least(1);
    expect(_.find(parser.warnings(), warning => warning.message.match(reWarningMsg))).to.not.be.undefined;
  });
};

// Expect the errors to contain one error that matches the reErrorMsg regex.
const parseContributionErrorTest = (text, reErrorMsg) => {
  const parser = new ParseContribution({});
  return parser.parsePromise({text: text}).then(() => {
    expect(parser.errors().length).to.be.at.least(1);
    expect(_.find(parser.errors(), error => error.message.match(reErrorMsg))).to.not.be.undefined;
  });
};

// Expect no errors.
const parseContributionNoErrorTest = (text) => {
  const parser = new ParseContribution({});
  return parser.parsePromise({text: text}).then(() => {
    expect(parser.errors().length).to.equal(0);
  });
};

// Expect no errors and check against expected JSON.
const parseContributionJSONTest = (text, jsonExpected) => {
  const parser = new ParseContribution({});
  return parser.parsePromise({text: text}).then(() => {
    expect(parser.errors().length).to.equal(0);
    expect(parser.json).to.deep.equal(jsonExpected);
  });
};

const parseContributionsJSONTest = (texts, jsonExpected) => {
  const parser = new ParseContribution({});
  return Promise.mapSeries(texts, text => parser.parsePromise({text: text})).then(() => {
    expect(parser.errors().length).to.equal(0);
    expect(parser.json).to.deep.equal(jsonExpected);
  });
};

// Expect the warnings to contain one warning that matches the reWarningMsg regex.
const getContributionVersionWarningTest = (json, reWarningMsg) => {
  const parser = new ParseContribution({});
  parser.getVersion(json);
  expect(parser.warnings().length).to.be.at.least(1);
  expect(_.find(parser.warnings(), warning => warning.message.match(reWarningMsg))).to.not.be.undefined;
};

// Expect the errors to contain one error that matches the reErrorMsg regex.
const getContributionVersionErrorTest = (json, reErrorMsg) => {
  const parser = new ParseContribution({});
  console.log(json);
  parser.getVersion(json);
  console.log(parser.errors());
  expect(parser.errors().length).to.be.at.least(1);
  expect(_.find(parser.errors(), error => error.message.match(reErrorMsg))).to.not.be.undefined;
};

// Expect the version to be guessed correctly.
const guessContributionVersionTest = (json, versionExpected) => {
  const parser = new ParseContribution({});
  let version = parser.getVersion(json);
  expect(parser.isVersionGuessed).to.be.true;
  expect(version).to.equal(versionExpected);
};