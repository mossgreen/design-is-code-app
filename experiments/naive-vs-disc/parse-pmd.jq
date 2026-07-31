# Turn PMD's JSON report into flat metric arrays.
#
# PMD writes descriptions like:
#   The method 'cancel(int, int, int, String)' has an NPath complexity of 1, ...
#   The class 'Owner' has a total cyclomatic complexity of 23 (highest 6).
#   A value of 7 may denote a high amount of coupling within the class ...
#
# ' is the apostrophe. Written as an escape so this file stays safe to
# embed anywhere.

def basename: split("/") | last;
def num($re): (.description | capture($re) | .n | tonumber);
def member: (.description | capture("(method|constructor) '(?<m>[^']*)'") | .m);

{
  npath: [ .files[] | (.filename | basename) as $f | .violations[]
           | select(.rule == "NPathComplexity")
           | { file: $f, method: (member // "?"),
               npath: num("complexity of (?<n>[0-9]+)") } ],

  cyclo: [ .files[] | (.filename | basename) as $f | .violations[]
           | select(.rule == "CyclomaticComplexity")
           | select(.description | test("The method|The constructor"))
           | { file: $f, method: (member // "?"),
               cyclo: num("complexity of (?<n>[0-9]+)") } ],

  cbo:   [ .files[] | (.filename | basename) as $f | .violations[]
           | select(.rule == "CouplingBetweenObjects")
           | { file: $f, cbo: num("A value of (?<n>[0-9]+)") } ]
}
